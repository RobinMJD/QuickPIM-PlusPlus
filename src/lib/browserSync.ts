import { APP_VERSION } from "./appMetadata";
import {
  browserFamilyLabel,
  type ExtensionDistributionInfo
} from "./distribution";
import {
  DEFAULT_SETTINGS,
  compareAndSetSettingsInStorage,
  loadSettingsSnapshotInStorage,
  mergeSettings
} from "./settings";
import { isSafeRecordKey } from "./security";
import { createStorageMutationLock } from "./storageMutation";
import type { ActivityHistoryEntry, QuickPimPreferences, QuickPimSettings, UsageStats } from "./types";

export const BROWSER_SYNC_ALARM_NAME = "quickPimBrowserSync";
export const BROWSER_SYNC_LOCAL_STATE_KEY = "quickPimBrowserSyncState.v1";
export const BROWSER_SYNC_PENDING_PURGE_KEY = "quickPimBrowserSyncPendingPurge.v1";
export const BROWSER_SYNC_CONTROL_KEY = "quickPimSync.control.v1";
export const BROWSER_SYNC_PURGE_KEY = "quickPimSync.purge.v1";
export const BROWSER_SYNC_EPOCH_KEY = "quickPimSync.epoch.v1";
export const BROWSER_SYNC_MANIFEST_KEY = "quickPimSync.manifest.v1";
export const BROWSER_SYNC_DEVICES_KEY = "quickPimSync.devices.v1";
export const BROWSER_SYNC_KEY_PREFIX = "quickPimSync.";
export const BROWSER_SYNC_REMINDER_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const BROWSER_SYNC_VERIFICATION_FRESHNESS_MS = 7 * 24 * 60 * 60 * 1000;

const BROWSER_SYNC_CHUNK_PREFIX = "quickPimSync.chunk.v1.";
const BROWSER_SYNC_DEVICE_PREFIX = "quickPimSync.device.v1.";
const BROWSER_SYNC_ATOMIC_GENERATION_MARKER = "a1";
// Chrome measures sync quota from the JSON-stringified value plus its key.
// Keep each chunk below the 8 KiB per-item ceiling and the complete payload
// small enough for the previous and next generations to coexist atomically.
const BROWSER_SYNC_CHUNK_QUOTA_BYTES = 8_000;
const BROWSER_SYNC_ORPHAN_GRACE_MS = 48 * 60 * 60_000;
const BROWSER_SYNC_DEVICE_HEARTBEAT_MS = 2 * 60_000;
const BROWSER_SYNC_READ_RETRY_DELAYS_MS = [100, 500, 1_500] as const;
const MAX_SYNC_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;
const SYNC_VERIFICATION_FUTURE_TOLERANCE_MS = 5 * 60_000;
const MAX_DATE_EPOCH_MS = 8_640_000_000_000_000;
// Keep enough headroom for the previous generation, device registry, and
// manifest while a replacement snapshot is being committed.
const BROWSER_SYNC_PAYLOAD_QUOTA_BYTES = 42_000;
const MAX_SYNC_DEVICES = 20;
const MAX_DEVICE_NAME_LENGTH = 60;
const MAX_SYNC_ACTIVITY_ENTRIES = 200;
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

interface BrowserSyncPurgeMarker {
  version: 1;
  purgedAt: number;
}

interface BrowserSyncEpochMarker {
  version: 1;
  epochAt: number;
}

interface BrowserSyncPendingPurge {
  version: 1;
  createdAt: number;
  completedAt?: number;
  lastError?: string;
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
  categoryBaselines?: Partial<Record<SyncCategoryName, unknown>>;
  pendingCategoryBaselines?: Partial<Record<SyncCategoryName, unknown>>;
  omittedCategories?: SyncCategoryName[];
  incompleteCategories?: SyncCategoryName[];
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
  crossDeviceState: "off" | "waiting" | "verified";
  otherInstallationCount: number;
  lastOtherInstallationSyncAt?: number;
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
  const stored = await readStoredBrowserSyncInstallationIdentity(apis.local);
  if (stored) return stored;
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

async function readStoredBrowserSyncInstallationIdentity(
  local: StorageAreaLike
): Promise<BrowserSyncInstallationIdentity | undefined> {
  const value = (await local.get(BROWSER_SYNC_LOCAL_STATE_KEY))[BROWSER_SYNC_LOCAL_STATE_KEY];
  if (!isRecord(value)) return undefined;
  const installationId = sanitizeInstallationId(value.installationId);
  const deviceName = sanitizeDeviceName(value.deviceName);
  return installationId && deviceName ? { installationId, deviceName } : undefined;
}

export function formatBrowserSyncInstallationId(installationId: string): string {
  const compact = installationId.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  return compact ? `QP-${compact.slice(0, 8)}` : "QP-UNKNOWN";
}

export function isBrowserSyncDeviceStorageKey(key: string): boolean {
  return key === BROWSER_SYNC_DEVICES_KEY || key.startsWith(BROWSER_SYNC_DEVICE_PREFIX);
}

export function isBrowserSyncPayloadStorageKey(key: string): boolean {
  return key === BROWSER_SYNC_CONTROL_KEY
    || key === BROWSER_SYNC_PURGE_KEY
    || key === BROWSER_SYNC_EPOCH_KEY
    || key === BROWSER_SYNC_MANIFEST_KEY
    || key.startsWith(BROWSER_SYNC_CHUNK_PREFIX);
}

export async function getBrowserSyncStatus(apis: BrowserSyncApis): Promise<BrowserSyncStatus> {
  return withBrowserSyncOperationLock(() => getBrowserSyncStatusUnlocked(apis));
}

async function getBrowserSyncStatusUnlocked(apis: BrowserSyncApis): Promise<BrowserSyncStatus> {
  const now = apis.now ?? Date.now();
  const capability = getBrowserSyncCapability(apis.distribution, Boolean(apis.sync));
  const state = await loadBrowserSyncLocalState(apis.local, apis.distribution, apis.platform, now, false);
  let control: BrowserSyncControl = { version: 1 };
  let registry: BrowserSyncDeviceRegistry = { version: 1, devices: [] };
  let statusReadError: string | undefined;
  if (apis.sync) {
    try {
      [control, registry] = await Promise.all([
        loadControl(apis.sync, now),
        loadDeviceRegistry(apis.sync, now)
      ]);
    } catch (error) {
      // A transient browser-sync outage must not make Settings unusable or
      // conceal the last locally recorded state. The next alarm or manual sync
      // can retry without touching local settings.
      statusReadError = sanitizeSyncError(error);
    }
  }
  const otherDevices = registry.devices.filter((device) => device.installationId !== state.installationId);
  const activeOtherDevices = otherDevices.filter((device) => isRecentlyActiveSyncDevice(device, now));
  const suspendedByPurge = Boolean(control.purgedAt && control.purgedAt > (state.lastAppliedPurgeAt || 0) && (control.epochAt || 0) <= control.purgedAt);
  return {
    ...capability,
    enabled: state.enabled,
    installationId: state.installationId,
    deviceName: state.deviceName,
    platform: normalizePlatform(apis.platform || detectPlatform()),
    lastSyncAt: state.lastSyncAt,
    lastSuccessAt: state.lastSuccessAt,
    lastError: state.lastError || statusReadError,
    reminderMode: state.reminderMode,
    reminderDue: !capability.supported
      && state.reminderMode !== "never"
      && (!state.lastReminderAt || now - state.lastReminderAt >= BROWSER_SYNC_REMINDER_INTERVAL_MS),
    suspendedByPurge,
    devices: registry.devices,
    crossDeviceState: !capability.supported || !state.enabled
      ? "off"
      : activeOtherDevices.length
        ? "verified"
        : "waiting",
    otherInstallationCount: activeOtherDevices.length,
    lastOtherInstallationSyncAt: otherDevices[0]?.lastSyncAt,
    omittedCategories: [...new Set([
      ...(state.omittedCategories || []),
      ...(state.incompleteCategories || [])
    ])]
  };
}

export async function synchronizeBrowserData(apis: BrowserSyncApis): Promise<BrowserSyncStatus> {
  return withBrowserSyncOperationLock(() => synchronizeBrowserDataUnlocked(apis));
}

async function synchronizeBrowserDataUnlocked(apis: BrowserSyncApis): Promise<BrowserSyncStatus> {
  const now = apis.now ?? Date.now();
  const capability = getBrowserSyncCapability(apis.distribution, Boolean(apis.sync));
  let state = await loadBrowserSyncLocalState(apis.local, apis.distribution, apis.platform, now);
  if (!capability.supported || !apis.sync) {
    return getBrowserSyncStatusUnlocked(apis);
  }

  const sync = apis.sync;
  const pendingPurge = await loadPendingBrowserSyncPurge(apis.local, now);
  if (pendingPurge) {
    if (pendingPurge.completedAt) {
      try {
        await apis.local.remove(BROWSER_SYNC_PENDING_PURGE_KEY);
      } catch (error) {
        state = {
          ...state,
          enabled: false,
          lastSyncAt: now,
          lastError: `Browser-synced data was deleted, but the local completion marker still needs cleanup: ${sanitizeSyncError(error)}`
        };
        await saveLocalState(apis.local, state);
        return getBrowserSyncStatusUnlocked(apis);
      }
    } else {
      try {
        const status = await purgeBrowserSyncDataUnlocked(apis);
        await apis.local.set({
          [BROWSER_SYNC_PENDING_PURGE_KEY]: {
            ...pendingPurge,
            completedAt: now,
            lastError: undefined
          } satisfies BrowserSyncPendingPurge
        });
        try {
          await apis.local.remove(BROWSER_SYNC_PENDING_PURGE_KEY);
        } catch {
          // The completed marker prevents a destructive purge from being repeated.
        }
        return status;
      } catch (error) {
        state = {
          ...state,
          enabled: false,
          lastSyncAt: now,
          lastError: `Local data was reset, but browser-synced data still needs deletion: ${sanitizeSyncError(error)}`
        };
        await saveLocalState(apis.local, state);
        return getBrowserSyncStatusUnlocked(apis);
      }
    }
  }
  if (!state.enabled) {
    return getBrowserSyncStatusUnlocked(apis);
  }
  try {
    await initializeBrowserSyncAccess(sync);
    state = await reconcileLocalDeviceName(apis.local, sync, state, now);
    const control = await loadControl(sync, now);
    if (isActiveBrowserSyncPurge(control)) {
      state = await pauseBrowserSyncAfterPurge(apis.local, sync, state, control.purgedAt || 0, now);
      return getBrowserSyncStatusUnlocked(apis);
    }

    const epochAt = control.epochAt || 0;
    const remote = await readRemoteSnapshot(sync, epochAt, now);
    const acknowledgedPendingBaseline = Boolean(
      remote?.manifest.generation
      && state.lastRemoteGeneration === remote.manifest.generation
      && state.pendingCategoryBaselines
    );
    const mergeBaselines = acknowledgedPendingBaseline
      ? state.pendingCategoryBaselines || state.categoryBaselines
      : state.categoryBaselines;
    const incompleteCategories = reconcileIncompleteCategories(state, remote);
    const localSettingsSnapshot = await loadSettingsSnapshotInStorage(apis.local);
    const localSnapshot = buildLocalSnapshot(localSettingsSnapshot.settings, state, now, remote?.snapshot);
    let merged = mergeSnapshots(
      localSnapshot.snapshot,
      remote?.snapshot,
      mergeBaselines,
      remote?.manifest.omittedCategories,
      localSnapshot.changedCategories
    );
    const mergedSettings = applySnapshotToSettings(localSettingsSnapshot.settings, merged);
    merged = normalizeSnapshotValues(merged, mergedSettings);
    const mergedHashes = getCategoryHashes(mergedSettings);
    const mergedValues = getSyncCategoryValues(mergedSettings);
    const fitted = fitSnapshotForSync(merged, incompleteCategories);
    const remoteHash = remote?.manifest.hash;
    const fittedHash = await hashSnapshot(canonicalStringify(fitted.snapshot));
    const omissionMetadataChanged = !valuesEqual(
      sanitizeCategoryNames(remote?.manifest.omittedCategories),
      fitted.omittedCategories
    );
    const localCommit = await compareAndSetSettingsInStorage(
      apis.local,
      localSettingsSnapshot.revision,
      mergedSettings
    );
    if (!localCommit.applied) {
      throw new Error("Local settings changed while browser sync was running. QuickPIM++ kept the newer local edit and will merge it on the next sync.");
    }

    let generation = remote?.manifest.generation;
    let wroteRemoteSnapshot = false;
    if (fittedHash !== remoteHash || omissionMetadataChanged) {
      generation = await writeRemoteSnapshot(
        sync,
        fitted.snapshot,
        state.installationId,
        now,
        fitted.omittedCategories,
        remote?.manifest.generation,
        epochAt
      );
      wroteRemoteSnapshot = true;
    }

    // A purge or resume can race with the snapshot work above. Re-read the
    // monotonic coordination markers before acknowledging success or writing
    // this installation's heartbeat. A stale snapshot is harmless because its
    // epoch is rejected, but a stale device record would otherwise reappear
    // after an explicit cloud purge.
    const finalControl = await loadControl(sync, now);
    if (isActiveBrowserSyncPurge(finalControl)) {
      state = await pauseBrowserSyncAfterPurge(apis.local, sync, state, finalControl.purgedAt || 0, now);
      return getBrowserSyncStatusUnlocked(apis);
    }
    if ((finalControl.epochAt || 0) > epochAt) {
      throw new Error("Browser sync coordination changed temporarily during this run. QuickPIM++ will retry automatically.");
    }

    const mergedCategoryUpdatedAt = Object.fromEntries(
      SYNC_CATEGORY_NAMES.flatMap((name) => merged.categories[name]
        ? [[name, merged.categories[name]!.updatedAt] as const]
        : [])
    );
    const completedState: BrowserSyncLocalState = {
      ...state,
      lastSyncAt: now,
      lastSuccessAt: now,
      lastError: undefined,
      lastRemoteGeneration: generation,
      categoryHashes: mergedHashes,
      categoryUpdatedAt: mergedCategoryUpdatedAt,
      // Do not acknowledge a generation in the three-way merge baseline until
      // a later pass reads it back. Another installation can commit a
      // different generation immediately after this write; keeping the old
      // baseline lets that follow-up merge both edits instead of treating the
      // temporarily hidden local edit as already synchronized.
      categoryBaselines: wroteRemoteSnapshot ? mergeBaselines : mergedValues,
      pendingCategoryBaselines: wroteRemoteSnapshot ? mergedValues : undefined,
      omittedCategories: fitted.omittedCategories,
      incompleteCategories
    };
    await updateDeviceRegistry(sync, completedState, capability.browserLabel, normalizePlatform(apis.platform || detectPlatform()), now, true);
    state = completedState;
    await saveLocalState(apis.local, state);
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

export async function queueBrowserSyncPurgeRetry(
  local: StorageAreaLike,
  error: unknown,
  now = Date.now()
): Promise<void> {
  const marker: BrowserSyncPendingPurge = {
    version: 1,
    createdAt: now,
    lastError: sanitizeSyncError(error)
  };
  await local.set({ [BROWSER_SYNC_PENDING_PURGE_KEY]: marker });
}

async function loadPendingBrowserSyncPurge(
  local: StorageAreaLike,
  now: number
): Promise<BrowserSyncPendingPurge | undefined> {
  const result = await local.get(BROWSER_SYNC_PENDING_PURGE_KEY);
  const value = result[BROWSER_SYNC_PENDING_PURGE_KEY];
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value) || value.version !== 1) {
    const marker: BrowserSyncPendingPurge = {
      version: 1,
      createdAt: now,
      lastError: "The local browser-sync purge marker was damaged. QuickPIM++ will repeat the safe cloud deletion before sync can resume."
    };
    await local.set({ [BROWSER_SYNC_PENDING_PURGE_KEY]: marker });
    return marker;
  }
  const createdAt = sanitizeTimestamp(value.createdAt, now);
  if (!createdAt) {
    const marker: BrowserSyncPendingPurge = {
      version: 1,
      createdAt: now,
      lastError: "The local browser-sync purge timestamp was invalid. QuickPIM++ will repeat the safe cloud deletion before sync can resume."
    };
    await local.set({ [BROWSER_SYNC_PENDING_PURGE_KEY]: marker });
    return marker;
  }
  return {
    version: 1,
    createdAt,
    completedAt: sanitizeTimestamp(value.completedAt, now),
    lastError: sanitizeText(value.lastError, 260) || undefined
  };
}

export async function setBrowserSyncEnabled(apis: BrowserSyncApis, enabled: boolean): Promise<BrowserSyncStatus> {
  return withBrowserSyncOperationLock(() => setBrowserSyncEnabledUnlocked(apis, enabled));
}

async function setBrowserSyncEnabledUnlocked(apis: BrowserSyncApis, enabled: boolean): Promise<BrowserSyncStatus> {
  const now = apis.now ?? Date.now();
  const capability = getBrowserSyncCapability(apis.distribution, Boolean(apis.sync));
  let state = await loadBrowserSyncLocalState(apis.local, apis.distribution, apis.platform, now);
  if (enabled && !capability.supported) {
    throw new Error(capability.reason || "Browser sync is unavailable for this installation.");
  }
  state = { ...state, enabled, lastError: undefined };
  await saveLocalState(apis.local, state);
  if (!apis.sync) return getBrowserSyncStatusUnlocked(apis);

  if (enabled) {
    try {
      const control = await loadControl(apis.sync, now);
      if (control.purgedAt && (control.epochAt || 0) <= control.purgedAt) {
        const epochAt = nextSyncRevision(now, control.purgedAt, control.epochAt || 0);
        if (epochAt <= control.purgedAt) {
          throw new Error("Browser clocks are too far apart to resume sync safely. Correct the system clock, then retry.");
        }
        // Resume and purge use independent keys so concurrent operations
        // cannot replace one another at the storage-item level. The legacy
        // control record remains readable for safe upgrades from older builds.
        await apis.sync.set({
          [BROWSER_SYNC_EPOCH_KEY]: { version: 1, epochAt } satisfies BrowserSyncEpochMarker
        });
        state = { ...state, lastAppliedPurgeAt: control.purgedAt };
        await saveLocalState(apis.local, state);
      }
    } catch (error) {
      state = {
        ...state,
        lastError: `Browser sync is enabled locally, but cloud state could not be checked: ${sanitizeSyncError(error)}`
      };
      await saveLocalState(apis.local, state);
      return getBrowserSyncStatusUnlocked(apis);
    }
    return synchronizeBrowserDataUnlocked(apis);
  }
  try {
    await updateDeviceRegistry(apis.sync, state, capability.browserLabel, normalizePlatform(apis.platform || detectPlatform()), now, false);
  } catch (error) {
    state = {
      ...state,
      lastError: `Browser sync is off locally, but the cloud installation status could not be updated: ${sanitizeSyncError(error)}`
    };
    await saveLocalState(apis.local, state);
  }
  return getBrowserSyncStatusUnlocked(apis);
}

export async function updateBrowserSyncDeviceName(apis: BrowserSyncApis, name: string): Promise<BrowserSyncStatus> {
  return withBrowserSyncOperationLock(() => updateBrowserSyncDeviceNameUnlocked(apis, name));
}

async function updateBrowserSyncDeviceNameUnlocked(apis: BrowserSyncApis, name: string): Promise<BrowserSyncStatus> {
  const now = apis.now ?? Date.now();
  const state = await loadBrowserSyncLocalState(apis.local, apis.distribution, apis.platform, now);
  const deviceName = sanitizeDeviceName(name) || buildDefaultDeviceName(apis.distribution, apis.platform);
  const capability = getBrowserSyncCapability(apis.distribution, Boolean(apis.sync));
  let remoteDevice: BrowserSyncDevice | undefined;
  let deliveryError: string | undefined;
  if (apis.sync && state.enabled && capability.supported) {
    try {
      remoteDevice = await loadDeviceRecord(apis.sync, state.installationId, now);
    } catch (error) {
      deliveryError = sanitizeSyncError(error);
    }
  }
  const nextState = {
    ...state,
    deviceName,
    deviceNameUpdatedAt: nextSyncRevision(now, state.deviceNameUpdatedAt, remoteDevice?.nameUpdatedAt || 0),
    lastError: deliveryError
      ? `The installation name is saved locally, but could not be sent yet: ${deliveryError}`
      : undefined
  };
  await saveLocalState(apis.local, nextState);
  if (apis.sync && state.enabled && capability.supported && !deliveryError) {
    try {
      await updateDeviceRegistry(
        apis.sync,
        nextState,
        browserFamilyLabel(apis.distribution.browser),
        normalizePlatform(apis.platform || detectPlatform()),
        now,
        state.enabled
      );
    } catch (error) {
      await saveLocalState(apis.local, {
        ...nextState,
        lastError: `The installation name is saved locally, but could not be sent yet: ${sanitizeSyncError(error)}`
      });
    }
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
  const now = apis.now ?? Date.now();
  const state = await loadBrowserSyncLocalState(apis.local, apis.distribution, apis.platform, now);
  if (!state.enabled) {
    throw new Error("Enable Browser Sync on this installation before renaming another installation.");
  }
  const safeId = sanitizeInstallationId(installationId);
  const deviceName = sanitizeDeviceName(name);
  if (!safeId || !deviceName) throw new Error("Choose a valid installation and name.");
  const device = await loadDeviceRecord(apis.sync, safeId, now);
  if (!device) throw new Error("This installation is no longer present in browser sync.");
  const renamed = {
    ...device,
    name: deviceName,
    nameUpdatedAt: nextSyncRevision(now, device.nameUpdatedAt)
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
  const now = apis.now ?? Date.now();
  const state = await loadBrowserSyncLocalState(apis.local, apis.distribution, apis.platform, now);
  await saveLocalState(apis.local, {
    ...state,
    reminderMode: mode,
    lastReminderAt: now
  });
  return getBrowserSyncStatusUnlocked(apis);
}

export async function markBrowserSyncReminderShown(apis: BrowserSyncApis): Promise<void> {
  return withBrowserSyncOperationLock(() => markBrowserSyncReminderShownUnlocked(apis));
}

async function markBrowserSyncReminderShownUnlocked(apis: BrowserSyncApis): Promise<void> {
  const now = apis.now ?? Date.now();
  const state = await loadBrowserSyncLocalState(apis.local, apis.distribution, apis.platform, now);
  if (state.reminderMode === "never") return;
  await saveLocalState(apis.local, {
    ...state,
    lastReminderAt: now
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
  const currentControl = await loadControl(apis.sync, now);
  const purgedAt = nextSyncRevision(now, currentControl.purgedAt || 0, currentControl.epochAt || 0);
  if (purgedAt <= Math.max(currentControl.purgedAt || 0, currentControl.epochAt || 0)) {
    throw new Error("Browser clocks are too far apart to purge synced data safely. Correct the system clock, then retry.");
  }
  await apis.sync.set({
    [BROWSER_SYNC_CONTROL_KEY]: { version: 1, purgedAt, epochAt: 0 } satisfies BrowserSyncControl,
    [BROWSER_SYNC_PURGE_KEY]: { version: 1, purgedAt } satisfies BrowserSyncPurgeMarker
  });
  const all = await apis.sync.get(null);
  const coordinationKeys = new Set([
    BROWSER_SYNC_CONTROL_KEY,
    BROWSER_SYNC_PURGE_KEY,
    BROWSER_SYNC_EPOCH_KEY
  ]);
  const keys = Object.keys(all).filter((key) =>
    key.startsWith(BROWSER_SYNC_KEY_PREFIX) && !coordinationKeys.has(key)
  );
  if (keys.length) {
    const latest = await apis.sync.get(keys);
    const unchangedKeys = keys.filter((key) => valuesEqual(latest[key], all[key]));
    if (unchangedKeys.length) await apis.sync.remove(unchangedKeys);
  }
  const state = await loadBrowserSyncLocalState(apis.local, apis.distribution, apis.platform, now);
  await saveLocalState(apis.local, {
    ...state,
    enabled: false,
    lastAppliedPurgeAt: purgedAt,
    lastSyncAt: now,
    lastSuccessAt: undefined,
    lastRemoteGeneration: undefined,
    lastError: undefined,
    categoryHashes: {},
    categoryUpdatedAt: {},
    categoryBaselines: getSyncCategoryValues(DEFAULT_SETTINGS),
    pendingCategoryBaselines: undefined,
    omittedCategories: [],
    incompleteCategories: []
  });
  return getBrowserSyncStatusUnlocked(apis);
}

export function sanitizeBrowserSyncStatus(value: unknown): BrowserSyncStatus | null {
  if (!isRecord(value) || typeof value.supported !== "boolean" || typeof value.enabled !== "boolean") return null;
  const capability = value.capability === "available" || value.capability === "limited" || value.capability === "unavailable"
    ? value.capability
    : value.supported ? "available" : "limited";
  const now = Date.now();
  const devices = sanitizeDevices(value.devices, now);
  const installationId = sanitizeInstallationId(value.installationId);
  const otherDevices = devices.filter((device) => device.installationId !== installationId);
  const activeOtherDevices = otherDevices.filter((device) => isRecentlyActiveSyncDevice(device, now));
  const crossDeviceState = !value.supported || !value.enabled
    ? "off"
    : activeOtherDevices.length
      ? "verified"
      : "waiting";
  return {
    capability,
    supported: value.supported,
    enabled: value.enabled,
    browserLabel: sanitizeText(value.browserLabel, 80) || "Browser",
    sourceLabel: sanitizeText(value.sourceLabel, 80) || "Unknown installation",
    ecosystemLabel: sanitizeText(value.ecosystemLabel, 80) || undefined,
    reason: sanitizeText(value.reason, 400) || undefined,
    installationId,
    deviceName: sanitizeDeviceName(value.deviceName) || "This installation",
    platform: sanitizeText(value.platform, 80) || "Unknown platform",
    lastSyncAt: sanitizeTimestamp(value.lastSyncAt, now),
    lastSuccessAt: sanitizeTimestamp(value.lastSuccessAt, now),
    lastError: sanitizeText(value.lastError, 300) || undefined,
    reminderMode: value.reminderMode === "never" ? "never" : "daily",
    reminderDue: value.reminderDue === true,
    suspendedByPurge: value.suspendedByPurge === true,
    devices,
    crossDeviceState,
    otherInstallationCount: Math.min(
      MAX_SYNC_DEVICES,
      Math.max(0, activeOtherDevices.length)
    ),
    lastOtherInstallationSyncAt: sanitizeTimestamp(value.lastOtherInstallationSyncAt, now) || otherDevices[0]?.lastSyncAt,
    omittedCategories: sanitizeCategoryNames(value.omittedCategories)
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
  const changedCategories = new Set<SyncCategoryName>();
  const defaultHashes = getCategoryHashes(DEFAULT_SETTINGS);
  const hashes = getCategoryHashes(settings);
  for (const name of SYNC_CATEGORY_NAMES) {
    const hasKnownLocalHash = state.categoryHashes[name] !== undefined;
    const changed = hasKnownLocalHash
      ? state.categoryHashes[name] !== hashes[name]
      : hashes[name] !== defaultHashes[name];
    if (changed) changedCategories.add(name);
    const initialTimestamp = hashes[name] === defaultHashes[name] ? 0 : now;
    const inheritedRemote = !changed && !hasKnownLocalHash ? remote?.categories[name] : undefined;
    const previousRevision = Math.max(
      state.categoryUpdatedAt[name] || 0,
      remote?.categories[name]?.updatedAt || 0
    );
    const changedTimestamp = nextSyncRevision(
      now,
      previousRevision
    );
    if (changed && changedTimestamp <= previousRevision) {
      throw new Error("Browser clocks are too far apart to order this settings change safely. QuickPIM++ kept the local change; correct the system clock, then retry sync.");
    }
    categories[name] = {
      updatedAt: changed
        ? state.categoryHashes[name] === undefined && initialTimestamp === 0 ? 0 : changedTimestamp
        : inheritedRemote?.updatedAt ?? state.categoryUpdatedAt[name] ?? initialTimestamp,
      updatedBy: inheritedRemote?.updatedBy || state.installationId,
      value: values[name]
    };
  }
  return { snapshot: { version: 1 as const, categories }, hashes, changedCategories };
}

function mergeSnapshots(
  local: BrowserSyncSnapshot,
  remote?: BrowserSyncSnapshot,
  baselines: Partial<Record<SyncCategoryName, unknown>> = {},
  remoteOmittedCategories: SyncCategoryName[] = [],
  localChangedCategories = new Set<SyncCategoryName>()
): BrowserSyncSnapshot {
  if (!remote) return local;
  const categories: BrowserSyncSnapshot["categories"] = {};
  const incompleteRemote = new Set(remoteOmittedCategories);
  for (const name of SYNC_CATEGORY_NAMES) {
    const localCategory = local.categories[name];
    const remoteCategory = remote.categories[name];
    if (!localCategory) categories[name] = remoteCategory;
    else if (!remoteCategory) categories[name] = localCategory;
    else if (incompleteRemote.has(name) && !localChangedCategories.has(name) && name === "activityHistory") {
      categories[name] = mergeActivityHistoryCategoriesAdditively(localCategory, remoteCategory);
    } else if (incompleteRemote.has(name) && !localChangedCategories.has(name) && name === "usageStatsByItemId") {
      categories[name] = mergeUsageCategoriesAdditively(localCategory, remoteCategory);
    } else if (incompleteRemote.has(name) && !localChangedCategories.has(name) && name === "recentJustifications") {
      categories[name] = mergeIncompleteStringListCategories(localCategory, remoteCategory);
    } else if (name === "activityHistory") {
      categories[name] = mergeActivityHistoryCategories(localCategory, remoteCategory, baselines[name]);
    } else if (name === "usageStatsByItemId") {
      categories[name] = mergeUsageCategories(localCategory, remoteCategory, baselines[name]);
    } else {
      categories[name] = mergeBaselineAwareCategory(name, localCategory, remoteCategory, baselines[name]);
    }
  }
  return { version: 1, categories };
}

function normalizeSnapshotValues(snapshot: BrowserSyncSnapshot, settings: QuickPimSettings): BrowserSyncSnapshot {
  const values = getSyncCategoryValues(settings);
  return {
    version: 1,
    categories: Object.fromEntries(SYNC_CATEGORY_NAMES.flatMap((name) => {
      const category = snapshot.categories[name];
      return category ? [[name, { ...category, value: values[name] }] as const] : [];
    }))
  };
}

function mergeIncompleteStringListCategories(local: SyncCategory, remote: SyncCategory): SyncCategory {
  const localValues = Array.isArray(local.value) ? local.value.filter((item): item is string => typeof item === "string") : [];
  const remoteValues = Array.isArray(remote.value) ? remote.value.filter((item): item is string => typeof item === "string") : [];
  const winner = chooseCategoryMetadata(local, remote);
  const ordered = winner === local
    ? [...localValues, ...remoteValues]
    : [...remoteValues, ...localValues];
  return {
    ...winner,
    value: ordered.filter((value, index) => ordered.indexOf(value) === index)
  };
}

function mergeBaselineAwareCategory(
  name: SyncCategoryName,
  local: SyncCategory,
  remote: SyncCategory,
  baseline: unknown
): SyncCategory {
  if (valuesEqual(local.value, remote.value)) return { ...chooseCategoryMetadata(local, remote), value: local.value };
  if (baseline === undefined) return chooseCategoryMetadata(local, remote);
  if (valuesEqual(local.value, baseline)) return remote;
  if (valuesEqual(remote.value, baseline)) return local;

  const winner = chooseCategoryMetadata(local, remote);
  const localWins = winner === local;
  let value: unknown;
  if (name === "preferences" || name === "aliasesByItemId") {
    value = mergeRecordCategory(baseline, local.value, remote.value, localWins);
  } else if (name === "favoriteItemIds" || name === "savedJustifications" || name === "recentJustifications") {
    value = mergeStringListCategory(baseline, local.value, remote.value, localWins);
  } else if (name === "bundles") {
    value = mergeBundleCategory(baseline, local.value, remote.value, localWins);
  } else {
    value = winner.value;
  }
  return { ...winner, value: sanitizeSyncCategoryValue(name, value) ?? winner.value };
}

function mergeRecordCategory(baseline: unknown, local: unknown, remote: unknown, localWins: boolean): Record<string, unknown> {
  const baseRecord = isRecord(baseline) ? baseline : {};
  const localRecord = isRecord(local) ? local : {};
  const remoteRecord = isRecord(remote) ? remote : {};
  const merged: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(baseRecord), ...Object.keys(localRecord), ...Object.keys(remoteRecord)])) {
    if (!isSafeRecordKey(key)) continue;
    const baseValue = Object.hasOwn(baseRecord, key) ? baseRecord[key] : MISSING_VALUE;
    const localValue = Object.hasOwn(localRecord, key) ? localRecord[key] : MISSING_VALUE;
    const remoteValue = Object.hasOwn(remoteRecord, key) ? remoteRecord[key] : MISSING_VALUE;
    const resolved = key === "enabledFeatures" && Array.isArray(localValue) && Array.isArray(remoteValue)
      ? mergeStringListCategory(Array.isArray(baseValue) ? baseValue : [], localValue, remoteValue, localWins)
      : resolveThreeWayValue(baseValue, localValue, remoteValue, localWins);
    if (resolved !== MISSING_VALUE) merged[key] = structuredClone(resolved);
  }
  return sortObject(merged);
}

function mergeStringListCategory(baseline: unknown, local: unknown, remote: unknown, localWins: boolean): string[] {
  const baseValues = Array.isArray(baseline) ? baseline.filter((item): item is string => typeof item === "string") : [];
  const localValues = Array.isArray(local) ? local.filter((item): item is string => typeof item === "string") : [];
  const remoteValues = Array.isArray(remote) ? remote.filter((item): item is string => typeof item === "string") : [];
  const baseSet = new Set(baseValues);
  const localSet = new Set(localValues);
  const remoteSet = new Set(remoteValues);
  const included = new Set<string>();
  for (const value of new Set([...baseValues, ...localValues, ...remoteValues])) {
    const resolved = resolveThreeWayValue(baseSet.has(value), localSet.has(value), remoteSet.has(value), localWins);
    if (resolved === true) included.add(value);
  }
  return [...(localWins ? localValues : remoteValues), ...(localWins ? remoteValues : localValues), ...baseValues]
    .filter((value, index, values) => included.has(value) && values.indexOf(value) === index);
}

function mergeBundleCategory(baseline: unknown, local: unknown, remote: unknown, localWins: boolean): unknown[] {
  const toMap = (value: unknown) => new Map(
    (Array.isArray(value) ? value : [])
      .filter((item): item is Record<string, unknown> => isRecord(item) && typeof item.id === "string")
      .map((item) => [item.id as string, item])
  );
  const baseMap = toMap(baseline);
  const localMap = toMap(local);
  const remoteMap = toMap(remote);
  const merged = new Map<string, unknown>();
  for (const id of new Set([...baseMap.keys(), ...localMap.keys(), ...remoteMap.keys()])) {
    const resolved = mergeBundleValue(
      baseMap.has(id) ? baseMap.get(id) : MISSING_VALUE,
      localMap.has(id) ? localMap.get(id) : MISSING_VALUE,
      remoteMap.has(id) ? remoteMap.get(id) : MISSING_VALUE,
      localWins
    );
    if (resolved !== MISSING_VALUE) merged.set(id, structuredClone(resolved));
  }
  const winnerOrder = localWins ? [...localMap.keys()] : [...remoteMap.keys()];
  const loserOrder = localWins ? [...remoteMap.keys()] : [...localMap.keys()];
  return [...winnerOrder, ...loserOrder, ...baseMap.keys()]
    .filter((id, index, ids) => merged.has(id) && ids.indexOf(id) === index)
    .map((id) => merged.get(id));
}

function mergeBundleValue(
  baseline: unknown,
  local: unknown,
  remote: unknown,
  localWins: boolean
): unknown {
  if (valuesEqual(local, remote)) return local;
  if (valuesEqual(local, baseline)) return remote;
  if (valuesEqual(remote, baseline)) return local;
  if (!isRecord(local) || !isRecord(remote)) return localWins ? local : remote;

  const baseRecord = isRecord(baseline) ? baseline : {};
  const merged: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(baseRecord), ...Object.keys(local), ...Object.keys(remote)])) {
    if (!isSafeRecordKey(key)) continue;
    const baseValue = Object.hasOwn(baseRecord, key) ? baseRecord[key] : MISSING_VALUE;
    const localValue = Object.hasOwn(local, key) ? local[key] : MISSING_VALUE;
    const remoteValue = Object.hasOwn(remote, key) ? remote[key] : MISSING_VALUE;
    const fieldValue = key === "itemIds" && Array.isArray(localValue) && Array.isArray(remoteValue)
      ? mergeStringListCategory(
        Array.isArray(baseValue) ? baseValue : [],
        localValue,
        remoteValue,
        localWins
      )
      : resolveThreeWayValue(baseValue, localValue, remoteValue, localWins);
    if (fieldValue !== MISSING_VALUE) merged[key] = structuredClone(fieldValue);
  }
  return merged;
}

const MISSING_VALUE = Symbol("missing-sync-value");

function resolveThreeWayValue(
  baseline: unknown,
  local: unknown,
  remote: unknown,
  localWins: boolean
): unknown {
  if (valuesEqual(local, remote)) return local;
  if (valuesEqual(local, baseline)) return remote;
  if (valuesEqual(remote, baseline)) return local;
  return localWins ? local : remote;
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (left === MISSING_VALUE || right === MISSING_VALUE) return left === right;
  return canonicalStringify(left) === canonicalStringify(right);
}

function mergeActivityHistoryCategories(local: SyncCategory, remote: SyncCategory, baseline: unknown): SyncCategory {
  const localEntries = sanitizeActivityHistoryValue(local.value);
  const remoteEntries = sanitizeActivityHistoryValue(remote.value);
  if (baseline !== undefined) {
    const baseMap = new Map(sanitizeActivityHistoryValue(baseline).map((entry) => [entry.id, entry]));
    const localMap = new Map(localEntries.map((entry) => [entry.id, entry]));
    const remoteMap = new Map(remoteEntries.map((entry) => [entry.id, entry]));
    const winner = chooseCategoryMetadata(local, remote);
    const entries: ActivityHistoryEntry[] = [];
    for (const id of new Set([...baseMap.keys(), ...localMap.keys(), ...remoteMap.keys()])) {
      const resolved = resolveThreeWayValue(
        baseMap.has(id) ? baseMap.get(id) : MISSING_VALUE,
        localMap.has(id) ? localMap.get(id) : MISSING_VALUE,
        remoteMap.has(id) ? remoteMap.get(id) : MISSING_VALUE,
        winner === local
      );
      if (resolved !== MISSING_VALUE) entries.push(structuredClone(resolved as ActivityHistoryEntry));
    }
    return {
      ...winner,
      value: entries
        .sort((left, right) => activityTimestamp(right).localeCompare(activityTimestamp(left)) || right.id.localeCompare(left.id))
        .slice(0, MAX_SYNC_ACTIVITY_ENTRIES)
    };
  }
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

function mergeActivityHistoryCategoriesAdditively(local: SyncCategory, remote: SyncCategory): SyncCategory {
  const entries = new Map<string, ActivityHistoryEntry>();
  for (const entry of [...sanitizeActivityHistoryValue(remote.value), ...sanitizeActivityHistoryValue(local.value)]) {
    const existing = entries.get(entry.id);
    if (!existing || compareActivityEntries(entry, existing) >= 0) entries.set(entry.id, entry);
  }
  return {
    ...chooseCategoryMetadata(local, remote),
    value: [...entries.values()]
      .sort((left, right) => activityTimestamp(right).localeCompare(activityTimestamp(left)) || right.id.localeCompare(left.id))
      .slice(0, MAX_SYNC_ACTIVITY_ENTRIES)
  };
}

function mergeUsageCategories(local: SyncCategory, remote: SyncCategory, baseline: unknown): SyncCategory {
  const localStats = sanitizeUsageValue(local.value);
  const remoteStats = sanitizeUsageValue(remote.value);
  if (baseline !== undefined) {
    const baseStats = sanitizeUsageValue(baseline);
    const winner = chooseCategoryMetadata(local, remote);
    const merged: Record<string, UsageStats> = {};
    for (const itemId of new Set([...Object.keys(baseStats), ...Object.keys(localStats), ...Object.keys(remoteStats)])) {
      if (!isSafeRecordKey(itemId)) continue;
      const base = baseStats[itemId];
      const left = localStats[itemId];
      const right = remoteStats[itemId];
      const baseValue = base || MISSING_VALUE;
      const leftValue = left || MISSING_VALUE;
      const rightValue = right || MISSING_VALUE;
      let resolved: unknown;
      if (valuesEqual(leftValue, rightValue)) resolved = leftValue;
      else if (valuesEqual(leftValue, baseValue)) resolved = rightValue;
      else if (valuesEqual(rightValue, baseValue)) resolved = leftValue;
      else resolved = mergeUsageStatsThreeWay(base, left, right, winner === local) || MISSING_VALUE;
      if (resolved !== MISSING_VALUE) merged[itemId] = structuredClone(resolved as UsageStats);
    }
    return { ...winner, value: sortObject(merged) };
  }
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

function mergeUsageCategoriesAdditively(local: SyncCategory, remote: SyncCategory): SyncCategory {
  const localStats = sanitizeUsageValue(local.value);
  const remoteStats = sanitizeUsageValue(remote.value);
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

function mergeUsageStatsThreeWay(
  baseline: UsageStats | undefined,
  local: UsageStats | undefined,
  remote: UsageStats | undefined,
  localWins: boolean
): UsageStats | undefined {
  const baselineByInstallation = baseline?.byInstallationId || {};
  const localByInstallation = local?.byInstallationId || {};
  const remoteByInstallation = remote?.byInstallationId || {};
  const byInstallationId: NonNullable<UsageStats["byInstallationId"]> = {};

  for (const installationId of new Set([
    ...Object.keys(baselineByInstallation),
    ...Object.keys(localByInstallation),
    ...Object.keys(remoteByInstallation)
  ])) {
    if (!isSafeRecordKey(installationId)) continue;
    const baseEntry = baselineByInstallation[installationId];
    const localEntry = localByInstallation[installationId];
    const remoteEntry = remoteByInstallation[installationId];
    const count = resolveUsageCounter(
      baseEntry?.activationCount,
      localEntry?.activationCount,
      remoteEntry?.activationCount,
      localWins
    );
    if (!count) continue;
    byInstallationId[installationId] = {
      activationCount: count,
      ...(latestTimestamp(localEntry?.lastUsedAt, remoteEntry?.lastUsedAt)
        ? { lastUsedAt: latestTimestamp(localEntry?.lastUsedAt, remoteEntry?.lastUsedAt) }
        : {})
    };
  }

  const legacyActivationCount = resolveUsageCounter(
    getLegacyUsageCount(baseline),
    getLegacyUsageCount(local),
    getLegacyUsageCount(remote),
    localWins
  ) || 0;
  const knownTotal = Object.values(byInstallationId).reduce((total, entry) => total + entry.activationCount, 0);
  const activationCount = Math.min(100000, legacyActivationCount + knownTotal);
  if (!activationCount) return undefined;
  return {
    activationCount,
    ...(latestTimestamp(local?.lastUsedAt, remote?.lastUsedAt)
      ? { lastUsedAt: latestTimestamp(local?.lastUsedAt, remote?.lastUsedAt) }
      : {}),
    ...(legacyActivationCount ? { legacyActivationCount } : {}),
    ...(Object.keys(byInstallationId).length ? { byInstallationId } : {})
  };
}

function resolveUsageCounter(
  baseline: number | undefined,
  local: number | undefined,
  remote: number | undefined,
  localWins: boolean
): number | undefined {
  if (local === remote) return local;
  if (local === baseline) return remote;
  if (remote === baseline) return local;

  // A reset removes the baseline count but must not erase activations that a
  // different installation recorded concurrently.
  if (local === undefined && remote !== undefined && baseline !== undefined && remote > baseline) {
    return remote - baseline;
  }
  if (remote === undefined && local !== undefined && baseline !== undefined && local > baseline) {
    return local - baseline;
  }
  if (local !== undefined && remote !== undefined) return Math.max(local, remote);
  return localWins ? local : remote;
}

function getLegacyUsageCount(value: UsageStats | undefined): number | undefined {
  if (!value) return undefined;
  const known = Object.values(value.byInstallationId || {}).reduce((total, entry) => total + entry.activationCount, 0);
  return value.legacyActivationCount ?? Math.max(0, value.activationCount - known);
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

function fitSnapshotForSync(
  snapshot: BrowserSyncSnapshot,
  incompleteCategories: SyncCategoryName[] = []
): { snapshot: BrowserSyncSnapshot; omittedCategories: SyncCategoryName[] } {
  const fitted: BrowserSyncSnapshot = structuredClone(snapshot);
  const omittedCategories: SyncCategoryName[] = [];
  const markLimited = (name: SyncCategoryName) => {
    if (!omittedCategories.includes(name)) omittedCategories.push(name);
  };
  for (const name of incompleteCategories) {
    markLimited(name);
  }
  const activityCategory = fitted.categories.activityHistory;
  if (activityCategory && snapshotStoragePayloadBytes(fitted) > BROWSER_SYNC_PAYLOAD_QUOTA_BYTES) {
    const originalEntries = sanitizeActivityHistoryValue(activityCategory.value);
    let entries = originalEntries;
    while (entries.length > 10 && snapshotStoragePayloadBytes(fitted) > BROWSER_SYNC_PAYLOAD_QUOTA_BYTES) {
      entries = entries.slice(0, Math.max(10, Math.floor(entries.length * 0.8)));
      activityCategory.value = entries;
    }
    if (entries.length < originalEntries.length) markLimited("activityHistory");
  }
  for (const name of ["usageStatsByItemId", "recentJustifications"] as SyncCategoryName[]) {
    if (snapshotStoragePayloadBytes(fitted) <= BROWSER_SYNC_PAYLOAD_QUOTA_BYTES) break;
    delete fitted.categories[name];
    markLimited(name);
  }
  if (activityCategory && snapshotStoragePayloadBytes(fitted) > BROWSER_SYNC_PAYLOAD_QUOTA_BYTES) {
    let entries = sanitizeActivityHistoryValue(activityCategory.value);
    while (entries.length > 1 && snapshotStoragePayloadBytes(fitted) > BROWSER_SYNC_PAYLOAD_QUOTA_BYTES) {
      entries = entries.slice(0, Math.max(1, Math.floor(entries.length * 0.7)));
      activityCategory.value = entries;
    }
    markLimited("activityHistory");
  }
  if (snapshotStoragePayloadBytes(fitted) > BROWSER_SYNC_PAYLOAD_QUOTA_BYTES && fitted.categories.activityHistory) {
    delete fitted.categories.activityHistory;
    markLimited("activityHistory");
  }
  // A single valid but unusually large category must not make every later sync
  // fail. Preserve preferences, then omit lower-priority portable categories in
  // a deterministic order. The omitted-category handshake keeps the complete
  // local copy authoritative and retries it when a later snapshot has room.
  for (const name of [
    "usageStatsByItemId",
    "recentJustifications",
    "savedJustifications",
    "favoriteItemIds",
    "aliasesByItemId",
    "bundles"
  ] as SyncCategoryName[]) {
    if (snapshotStoragePayloadBytes(fitted) <= BROWSER_SYNC_PAYLOAD_QUOTA_BYTES) break;
    if (!fitted.categories[name]) continue;
    delete fitted.categories[name];
    markLimited(name);
  }
  if (snapshotStoragePayloadBytes(fitted) > BROWSER_SYNC_PAYLOAD_QUOTA_BYTES) {
    throw new Error("Core preferences exceed the browser sync quota. QuickPIM++ kept local data unchanged; use Backup & Restore for this installation.");
  }
  return { snapshot: fitted, omittedCategories };
}

function reconcileIncompleteCategories(
  state: BrowserSyncLocalState,
  remote: { manifest: BrowserSyncManifest; snapshot: BrowserSyncSnapshot } | undefined
): SyncCategoryName[] {
  const incomplete = new Set(state.incompleteCategories || []);
  if (!remote) return [...incomplete];

  for (const name of SYNC_CATEGORY_NAMES) {
    if (remote.snapshot.categories[name] && !(remote.manifest.omittedCategories || []).includes(name)) {
      incomplete.delete(name);
    }
  }
  for (const name of remote.manifest.omittedCategories || []) {
    const locallyOmittedCompleteCopy = (state.omittedCategories || []).includes(name) && !incomplete.has(name);
    if (!locallyOmittedCompleteCopy) incomplete.add(name);
  }
  return SYNC_CATEGORY_NAMES.filter((name) => incomplete.has(name));
}

async function readRemoteSnapshot(
  sync: StorageAreaLike,
  minimumEpochAt = 0,
  now = Date.now()
): Promise<{ manifest: BrowserSyncManifest; snapshot: BrowserSyncSnapshot } | undefined> {
  for (let attempt = 0; attempt <= BROWSER_SYNC_READ_RETRY_DELAYS_MS.length; attempt += 1) {
    const manifestValue = (await sync.get(BROWSER_SYNC_MANIFEST_KEY))[BROWSER_SYNC_MANIFEST_KEY];
    if (manifestValue === undefined || manifestValue === null) return undefined;
    const manifest = sanitizeManifest(manifestValue, now);
    if (!manifest) {
      throw new Error("Synced settings metadata is invalid. QuickPIM++ kept local data unchanged.");
    }
    if ((manifest.epochAt || 0) < minimumEpochAt) return undefined;
    const keys = Array.from({ length: manifest.chunkCount }, (_, index) => chunkKey(manifest.generation, index));
    const chunks = await sync.get(keys);
    const serialized = keys.map((key) => typeof chunks[key] === "string" ? chunks[key] : "").join("");
    if (utf8Length(serialized) === manifest.byteLength && await hashMatchesManifest(serialized, manifest.hash)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(serialized);
      } catch {
        throw new Error("Synced settings contain invalid JSON. QuickPIM++ kept local data unchanged.");
      }
      const snapshot = sanitizeBrowserSyncSnapshot(parsed, now);
      if (!snapshot || hasInvalidKnownSyncCategory(parsed, snapshot)) {
        throw new Error("Synced settings use an invalid or unsupported format. QuickPIM++ kept local data unchanged.");
      }
      return { manifest, snapshot };
    }

    if (attempt < BROWSER_SYNC_READ_RETRY_DELAYS_MS.length) {
      await wait(BROWSER_SYNC_READ_RETRY_DELAYS_MS[attempt]!);
    }
  }
  throw new Error("Synced settings are still arriving. QuickPIM++ will retry automatically when browser sync delivers the remaining data.");
}

function hasInvalidKnownSyncCategory(parsed: unknown, snapshot: BrowserSyncSnapshot): boolean {
  if (!isRecord(parsed) || !isRecord(parsed.categories)) return true;
  const categories = parsed.categories;
  return SYNC_CATEGORY_NAMES.some((name) =>
    Object.hasOwn(categories, name) && !snapshot.categories[name]
  );
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
  const generation = `${now.toString(36)}-${BROWSER_SYNC_ATOMIC_GENERATION_MARKER}-${installationId.slice(-8)}-${randomId().slice(-6)}`;
  const chunks = splitForStorageItems(serialized, generation);
  await removeStaleOrphanedChunks(
    sync,
    now,
    new Set(previousGeneration ? [previousGeneration] : [])
  );
  const manifest: BrowserSyncManifest = {
    version: 1,
    generation,
    chunkCount: chunks.length,
    byteLength: utf8Length(serialized),
    hash: await hashSnapshot(serialized),
    updatedAt: now,
    updatedBy: installationId,
    ...(epochAt ? { epochAt } : {}),
    ...(omittedCategories.length ? { omittedCategories } : {})
  };
  const writtenKeys: string[] = [];
  try {
    // Individual writes stay below both the per-item and per-call sync quotas.
    // The manifest is committed last, so readers never treat a partial upload
    // as the current generation.
    for (let index = 0; index < chunks.length; index += 1) {
      const key = chunkKey(generation, index);
      await sync.set({ [key]: chunks[index] });
      writtenKeys.push(key);
    }

    const latestManifestValue = (await sync.get(BROWSER_SYNC_MANIFEST_KEY))[BROWSER_SYNC_MANIFEST_KEY];
    const latestManifest = latestManifestValue === undefined || latestManifestValue === null
      ? undefined
      : sanitizeManifest(latestManifestValue, now);
    if (latestManifestValue !== undefined && latestManifestValue !== null && !latestManifest) {
      throw new Error("Synced settings metadata changed to an invalid value while publishing. QuickPIM++ kept the existing cloud generation unchanged.");
    }
    const latestGenerationIsFromOlderEpoch = Boolean(
      latestManifest
      && (latestManifest.epochAt || 0) < epochAt
    );
    if (!latestGenerationIsFromOlderEpoch && (latestManifest?.generation || undefined) !== previousGeneration) {
      throw new Error("Another installation updated browser sync at the same time. QuickPIM++ will merge that generation on the next run.");
    }

    await sync.set({ [BROWSER_SYNC_MANIFEST_KEY]: manifest });
    const committed = sanitizeManifest((await sync.get(BROWSER_SYNC_MANIFEST_KEY))[BROWSER_SYNC_MANIFEST_KEY], now);
    if (committed?.generation !== generation || committed.hash !== manifest.hash) {
      throw new Error("Another installation completed browser sync at the same time. QuickPIM++ will reconcile both changes on the next run.");
    }
  } catch (error) {
    if (writtenKeys.length) {
      const latest = await sync.get(writtenKeys);
      const ownedKeys = writtenKeys.filter((key, index) => latest[key] === chunks[index]);
      if (ownedKeys.length) await sync.remove(ownedKeys);
    }
    throw error;
  }
  await removeStaleOrphanedChunks(sync, now, new Set([generation]));
  return generation;
}

async function removeStaleOrphanedChunks(
  sync: StorageAreaLike,
  now: number,
  protectedGenerations: Set<string>
): Promise<void> {
  const all = await sync.get(null);
  const currentManifest = sanitizeManifest(all[BROWSER_SYNC_MANIFEST_KEY], now);
  if (currentManifest) protectedGenerations.add(currentManifest.generation);
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
  if (staleKeys.length) {
    const latest = await sync.get(staleKeys);
    const unchangedKeys = staleKeys.filter((key) => valuesEqual(latest[key], all[key]));
    if (unchangedKeys.length) await sync.remove(unchangedKeys);
  }
}

async function loadBrowserSyncLocalState(
  local: StorageAreaLike,
  distribution: ExtensionDistributionInfo,
  platform?: string,
  now = Date.now(),
  persistNormalization = true
): Promise<BrowserSyncLocalState> {
  const value = (await local.get(BROWSER_SYNC_LOCAL_STATE_KEY))[BROWSER_SYNC_LOCAL_STATE_KEY];
  const source = isRecord(value) ? value : {};
  const installationId = sanitizeInstallationId(source.installationId) || randomId();
  const categoryBaselines = isRecord(value)
    ? sanitizeCategoryBaselines(source.categoryBaselines)
    : getSyncCategoryValues(DEFAULT_SETTINGS);
  const state: BrowserSyncLocalState = {
    version: 1,
    enabled: !isRecord(value) ? true : source.enabled === true,
    installationId,
    deviceName: sanitizeDeviceName(source.deviceName) || buildDefaultDeviceName(distribution, platform),
    deviceNameUpdatedAt: sanitizeTimestamp(source.deviceNameUpdatedAt, now) || 0,
    reminderMode: source.reminderMode === "never" ? "never" : "daily",
    lastReminderAt: sanitizeTimestamp(source.lastReminderAt, now),
    lastSyncAt: sanitizeTimestamp(source.lastSyncAt, now),
    lastSuccessAt: sanitizeTimestamp(source.lastSuccessAt, now),
    lastError: sanitizeText(source.lastError, 300) || undefined,
    lastRemoteGeneration: sanitizeText(source.lastRemoteGeneration, 120) || undefined,
    lastAppliedPurgeAt: sanitizeTimestamp(source.lastAppliedPurgeAt, now),
    categoryHashes: sanitizeCategoryNumberMap(source.categoryHashes, false),
    categoryUpdatedAt: sanitizeCategoryNumberMap(source.categoryUpdatedAt, true, now),
    categoryBaselines,
    pendingCategoryBaselines: isRecord(source.pendingCategoryBaselines)
      ? sanitizeCategoryBaselines(source.pendingCategoryBaselines)
      : undefined,
    omittedCategories: sanitizeCategoryNames(source.omittedCategories),
    incompleteCategories: sanitizeCategoryNames(source.incompleteCategories)
  };
  // Persist a newly generated identity immediately. Existing state is only
  // rewritten by mutating flows; status rendering stays read-only and cannot
  // wake storage listeners just because it normalized a legacy field.
  if (!isRecord(value) || (persistNormalization && canonicalStringify(value) !== canonicalStringify(state))) {
    await saveLocalState(local, state);
  }
  return state;
}

function sanitizeCategoryBaselines(value: unknown): Partial<Record<SyncCategoryName, unknown>> {
  if (!isRecord(value)) return {};
  const result: Partial<Record<SyncCategoryName, unknown>> = {};
  for (const name of SYNC_CATEGORY_NAMES) {
    if (!Object.hasOwn(value, name)) continue;
    const sanitized = sanitizeSyncCategoryValue(name, value[name]);
    if (sanitized !== undefined) result[name] = sanitized;
  }
  return result;
}

async function saveLocalState(local: StorageAreaLike, state: BrowserSyncLocalState): Promise<void> {
  await local.set({ [BROWSER_SYNC_LOCAL_STATE_KEY]: state });
}

async function loadControl(sync: StorageAreaLike, now = Date.now()): Promise<BrowserSyncControl> {
  const values = await sync.get([
    BROWSER_SYNC_CONTROL_KEY,
    BROWSER_SYNC_PURGE_KEY,
    BROWSER_SYNC_EPOCH_KEY
  ]);
  const value = values[BROWSER_SYNC_CONTROL_KEY];
  if (value !== undefined && value !== null && (!isRecord(value) || value.version !== 1)) {
    throw new Error("Synced control metadata uses an invalid or unsupported version. QuickPIM++ kept local data unchanged.");
  }
  const legacy = isRecord(value) ? value : {};
  const purgeMarker = values[BROWSER_SYNC_PURGE_KEY];
  const epochMarker = values[BROWSER_SYNC_EPOCH_KEY];
  const legacyPurgedAt = sanitizeTimestamp(legacy.purgedAt, now);
  const legacyEpochAt = sanitizeTimestamp(legacy.epochAt, now);
  const splitPurgedAt = sanitizeMonotonicMarker(purgeMarker, "purgedAt", now);
  const splitEpochAt = sanitizeMonotonicMarker(epochMarker, "epochAt", now);
  const hasInvalidPurge = Object.hasOwn(legacy, "purgedAt") && legacy.purgedAt !== undefined && !legacyPurgedAt;
  const hasInvalidEpoch = Object.hasOwn(legacy, "epochAt")
    && legacy.epochAt !== undefined
    && Number(legacy.epochAt) !== 0
    && !legacyEpochAt;
  if (hasInvalidPurge || hasInvalidEpoch) {
    throw new Error("Synced control metadata contains an invalid timestamp. QuickPIM++ kept local data unchanged.");
  }
  return {
    version: 1,
    purgedAt: Math.max(legacyPurgedAt || 0, splitPurgedAt || 0) || undefined,
    epochAt: Math.max(legacyEpochAt || 0, splitEpochAt || 0) || undefined
  };
}

function sanitizeMonotonicMarker(
  value: unknown,
  field: "purgedAt" | "epochAt",
  now: number
): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value) || value.version !== 1) {
    throw new Error(`Synced ${field === "purgedAt" ? "purge" : "resume"} metadata uses an invalid or unsupported version. QuickPIM++ kept local data unchanged.`);
  }
  const timestamp = sanitizeTimestamp(value[field], now);
  if (!timestamp) {
    throw new Error(`Synced ${field === "purgedAt" ? "purge" : "resume"} metadata contains an invalid timestamp. QuickPIM++ kept local data unchanged.`);
  }
  return timestamp;
}

function isActiveBrowserSyncPurge(control: BrowserSyncControl): boolean {
  return Boolean(control.purgedAt && (control.epochAt || 0) <= control.purgedAt);
}

async function pauseBrowserSyncAfterPurge(
  local: StorageAreaLike,
  sync: StorageAreaLike,
  state: BrowserSyncLocalState,
  purgedAt: number,
  now: number
): Promise<BrowserSyncLocalState> {
  const next = {
    ...state,
    enabled: false,
    lastAppliedPurgeAt: Math.max(state.lastAppliedPurgeAt || 0, purgedAt),
    lastSyncAt: now,
    lastError: "Synced data was deleted from another installation. Sync is paused until you enable it again."
  };
  await saveLocalState(local, next);
  try {
    await sync.remove(deviceKey(state.installationId));
  } catch {
    // The tombstone still protects synced settings. A later reconciliation can
    // retry removal of this non-sensitive installation heartbeat.
  }
  return next;
}

async function loadDeviceRegistry(sync: StorageAreaLike, now = Date.now()): Promise<BrowserSyncDeviceRegistry> {
  return buildDeviceRegistry(await sync.get(null), now);
}

async function loadDeviceRecord(
  sync: StorageAreaLike,
  installationId: string,
  now = Date.now()
): Promise<BrowserSyncDevice | undefined> {
  const key = deviceKey(installationId);
  const direct = sanitizeDevices([(await sync.get(key))[key]], now)[0];
  return direct || (await loadDeviceRegistry(sync, now)).devices.find((device) => device.installationId === installationId);
}

function buildDeviceRegistry(values: Record<string, unknown>, now = Date.now()): BrowserSyncDeviceRegistry {
  const legacy = values[BROWSER_SYNC_DEVICES_KEY];
  const candidates = [
    ...(isRecord(legacy) && Array.isArray(legacy.devices) ? legacy.devices : []),
    ...Object.entries(values)
      .filter(([key]) => key.startsWith(BROWSER_SYNC_DEVICE_PREFIX))
      .map(([, value]) => value)
  ];
  const devicesById = new Map<string, BrowserSyncDevice>();
  for (const device of sanitizeDevices(candidates, now)) {
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
  const existing = await loadDeviceRecord(sync, state.installationId, now);
  const current: BrowserSyncDevice = {
    installationId: state.installationId,
    name: existing && existing.nameUpdatedAt > state.deviceNameUpdatedAt ? existing.name : state.deviceName,
    browser,
    platform,
    appVersion: APP_VERSION,
    lastSyncAt: Math.max(existing?.lastSyncAt || 0, now),
    syncEnabled,
    nameUpdatedAt: Math.max(existing?.nameUpdatedAt || 0, state.deviceNameUpdatedAt)
  };
  const recordChanged = !existing
    || existing.name !== current.name
    || existing.browser !== current.browser
    || existing.platform !== current.platform
    || existing.appVersion !== current.appVersion
    || existing.syncEnabled !== current.syncEnabled
    || existing.nameUpdatedAt !== current.nameUpdatedAt;
  const heartbeatDue = !existing
    || now - existing.lastSyncAt >= BROWSER_SYNC_DEVICE_HEARTBEAT_MS;
  if (recordChanged || heartbeatDue) {
    await sync.set({ [deviceKey(state.installationId)]: current });
  }
  const all = await sync.get(null);
  const latestRegistry = buildDeviceRegistry(all, now);
  const legacyMigrations = Object.fromEntries(latestRegistry.devices.flatMap((device) => {
    const key = deviceKey(device.installationId);
    return Object.hasOwn(all, key) ? [] : [[key, device] as const];
  }));
  if (Object.keys(legacyMigrations).length) await sync.set(legacyMigrations);
  const retainedDevices = latestRegistry.devices.some((device) => device.installationId === state.installationId)
    ? latestRegistry.devices
    : [...latestRegistry.devices.slice(0, MAX_SYNC_DEVICES - 1), current];
  const retainedIds = new Set(retainedDevices.map((device) => device.installationId));
  const staleDeviceKeys = Object.keys(all).filter((key) => {
    if (!key.startsWith(BROWSER_SYNC_DEVICE_PREFIX)) return false;
    return !retainedIds.has(key.slice(BROWSER_SYNC_DEVICE_PREFIX.length));
  });
  if (Object.hasOwn(all, BROWSER_SYNC_DEVICES_KEY)) staleDeviceKeys.push(BROWSER_SYNC_DEVICES_KEY);
  if (staleDeviceKeys.length) {
    const latestCandidates = await sync.get(staleDeviceKeys);
    const unchangedKeys = staleDeviceKeys.filter((key) =>
      valuesEqual(latestCandidates[key], all[key])
    );
    if (unchangedKeys.length) await sync.remove(unchangedKeys);
  }
}

function sanitizeDevices(value: unknown, now = Date.now()): BrowserSyncDevice[] {
  if (!Array.isArray(value)) return [];
  const devicesById = new Map<string, BrowserSyncDevice>();
  for (const item of value) {
    if (!isRecord(item)) continue;
    const installationId = sanitizeInstallationId(item.installationId);
    const parsedLastSyncAt = sanitizeTimestamp(item.lastSyncAt, now);
    if (parsedLastSyncAt && parsedLastSyncAt > now + SYNC_VERIFICATION_FUTURE_TOLERANCE_MS) continue;
    const lastSyncAt = parsedLastSyncAt ? Math.min(parsedLastSyncAt, now) : undefined;
    if (!installationId || !lastSyncAt) continue;
    const parsedNameUpdatedAt = sanitizeTimestamp(item.nameUpdatedAt, now);
    const device: BrowserSyncDevice = {
      installationId,
      name: sanitizeDeviceName(item.name) || "QuickPIM++ installation",
      browser: sanitizeText(item.browser, 80) || "Browser",
      platform: sanitizeText(item.platform, 80) || "Unknown platform",
      appVersion: sanitizeText(item.appVersion, 30) || "Unknown version",
      lastSyncAt,
      syncEnabled: item.syncEnabled !== false,
      nameUpdatedAt: parsedNameUpdatedAt && parsedNameUpdatedAt <= now + SYNC_VERIFICATION_FUTURE_TOLERANCE_MS
        ? Math.min(parsedNameUpdatedAt, now)
        : 0
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
  state: BrowserSyncLocalState,
  now = Date.now()
): Promise<BrowserSyncLocalState> {
  const device = await loadDeviceRecord(sync, state.installationId, now);
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

export function sanitizeBrowserSyncSnapshot(value: unknown, now = Date.now()): BrowserSyncSnapshot | undefined {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.categories)) return undefined;
  const categories: BrowserSyncSnapshot["categories"] = {};
  for (const name of SYNC_CATEGORY_NAMES) {
    const category = value.categories[name];
    if (!isRecord(category)) continue;
    const updatedAt = Number(category.updatedAt);
    const updatedBy = sanitizeInstallationId(category.updatedBy);
    const sanitizedValue = sanitizeSyncCategoryValue(name, category.value);
    if (!Number.isFinite(updatedAt) || updatedAt < 0 || updatedAt > maximumSyncTimestamp(now) || !updatedBy || sanitizedValue === undefined) continue;
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

function sanitizeManifest(value: unknown, now = Date.now()): BrowserSyncManifest | undefined {
  if (!isRecord(value) || value.version !== 1) return undefined;
  const generation = sanitizeGeneration(value.generation);
  const chunkCount = Number(value.chunkCount);
  const byteLength = Number(value.byteLength);
  const hash = sanitizeText(value.hash, 64);
  const updatedAt = Number(value.updatedAt);
  const updatedBy = sanitizeInstallationId(value.updatedBy);
  const epochAt = sanitizeTimestamp(value.epochAt, now);
  const hasInvalidEpoch = Object.hasOwn(value, "epochAt")
    && value.epochAt !== undefined
    && Number(value.epochAt) !== 0
    && !epochAt;
  if (!generation || !Number.isInteger(chunkCount) || chunkCount < 1 || chunkCount > 20 || !Number.isInteger(byteLength) || byteLength < 1 || byteLength > BROWSER_SYNC_PAYLOAD_QUOTA_BYTES || !/^(?:[0-9a-f]{8}|[0-9a-f]{64})$/i.test(hash) || !Number.isFinite(updatedAt) || updatedAt <= 0 || updatedAt > maximumSyncTimestamp(now) || !updatedBy || hasInvalidEpoch) return undefined;
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

function sanitizeCategoryNumberMap(value: unknown, numeric: true, now?: number): Partial<Record<SyncCategoryName, number>>;
function sanitizeCategoryNumberMap(value: unknown, numeric: false, now?: number): Partial<Record<SyncCategoryName, string>>;
function sanitizeCategoryNumberMap(value: unknown, numeric: boolean, now = Date.now()) {
  if (!isRecord(value)) return {};
  const result: Partial<Record<SyncCategoryName, number | string>> = {};
  for (const name of SYNC_CATEGORY_NAMES) {
    const item = value[name];
    if (numeric) {
      const parsed = Number(item);
      if (Number.isFinite(parsed) && parsed >= 0 && parsed <= maximumSyncTimestamp(now)) result[name] = parsed;
    } else if (typeof item === "string" && item.length <= 32) {
      result[name] = item;
    }
  }
  return result;
}

function sanitizeCategoryNames(value: unknown): SyncCategoryName[] {
  if (!Array.isArray(value)) return [];
  const selected = new Set(value.filter((item): item is SyncCategoryName => SYNC_CATEGORY_NAMES.includes(item as SyncCategoryName)));
  return SYNC_CATEGORY_NAMES.filter((name) => selected.has(name));
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

function sanitizeInstallationId(value: unknown): string {
  const sanitized = sanitizeText(value, 80);
  return /^[a-zA-Z0-9-]{8,80}$/.test(sanitized) ? sanitized : "";
}

function sanitizeGeneration(value: unknown): string {
  const sanitized = sanitizeText(value, 120);
  return /^[a-z0-9-]{3,120}$/i.test(sanitized) ? sanitized : "";
}

function sanitizeText(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength) : "";
}

function sanitizeTimestamp(value: unknown, now?: number): number | undefined {
  const parsed = Number(value);
  const maximum = now === undefined ? MAX_DATE_EPOCH_MS : maximumSyncTimestamp(now);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= maximum ? parsed : undefined;
}

function maximumSyncTimestamp(now: number): number {
  return Math.min(MAX_DATE_EPOCH_MS, Math.max(0, now) + MAX_SYNC_CLOCK_SKEW_MS);
}

function nextSyncRevision(now: number, ...previousValues: number[]): number {
  return Math.min(
    maximumSyncTimestamp(now),
    Math.max(now, ...previousValues.map((value) => Number.isFinite(value) ? value + 1 : 0))
  );
}

function isRecentlyActiveSyncDevice(device: BrowserSyncDevice, now: number): boolean {
  return device.syncEnabled
    && device.lastSyncAt <= now + SYNC_VERIFICATION_FUTURE_TOLERANCE_MS
    && now - device.lastSyncAt <= BROWSER_SYNC_VERIFICATION_FRESHNESS_MS;
}

function sanitizeSyncError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || "Browser sync failed.");
  return sanitizeText(message, 300) || "Browser sync failed.";
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function randomId(): string {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `install-${Date.now().toString(36)}-${Array.from(crypto.getRandomValues(new Uint8Array(16)), (value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function chunkKey(generation: string, index: number): string {
  return `${BROWSER_SYNC_CHUNK_PREFIX}${generation}.${index}`;
}

function splitForStorageItems(value: string, generation: string): string[] {
  const chunks: string[] = [];
  let current = "";
  let bytes = storageItemBaseBytes(chunkKey(generation, 0));
  for (const character of value) {
    const characterBytes = jsonStringContentBytes(character);
    if (current && bytes + characterBytes > BROWSER_SYNC_CHUNK_QUOTA_BYTES) {
      chunks.push(current);
      current = "";
      bytes = storageItemBaseBytes(chunkKey(generation, chunks.length));
    }
    current += character;
    bytes += characterBytes;
  }
  if (current) chunks.push(current);
  return chunks;
}

function storageItemBaseBytes(key: string): number {
  return utf8Length(key) + utf8Length(JSON.stringify(""));
}

function jsonStringContentBytes(value: string): number {
  return utf8Length(JSON.stringify(value)) - utf8Length(JSON.stringify(""));
}

function snapshotStoragePayloadBytes(snapshot: BrowserSyncSnapshot): number {
  return utf8Length(JSON.stringify(canonicalStringify(snapshot)));
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

async function hashSnapshot(value: string): Promise<string> {
  if (!crypto.subtle) {
    throw new Error("This browser cannot verify browser-sync snapshot integrity safely.");
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hashMatchesManifest(value: string, expected: string): Promise<boolean> {
  if (/^[0-9a-f]{8}$/i.test(expected)) {
    // Read-only compatibility with snapshots produced before SHA-256 support.
    return hashString(value) === expected.toLowerCase();
  }
  return await hashSnapshot(value) === expected.toLowerCase();
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
