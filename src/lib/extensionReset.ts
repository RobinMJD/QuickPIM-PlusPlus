import { BROWSER_SYNC_PENDING_PURGE_KEY, createBrowserSyncPurgeMarker } from "./browserSync";
import type { RequestOperationRecord } from "./types";

export interface ExtensionResetApis {
  loadRequestOperations(): Promise<RequestOperationRecord[]>;
  hasInFlightTasks(): boolean;
  closePortalRecoveryTabs(): Promise<unknown>;
  clearNotifications(): Promise<void>;
  removeNotificationPermission(): Promise<unknown>;
  purgeSyncedData(): Promise<unknown>;
  local: ResetStorageAreaLike;
  session: ResetSessionStorageLike;
  clearAlarms(): Promise<unknown>;
  clearActionBadge(): Promise<unknown>;
}

export const EXTENSION_RESET_PENDING_KEY = "quickPimResetPending.v1";

interface ResetStorageAreaLike {
  get(key: string | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

interface ResetSessionStorageLike {
  clear(): Promise<void>;
}

export async function resumePendingExtensionReset(
  local: ResetStorageAreaLike,
  session: ResetSessionStorageLike
): Promise<boolean> {
  const { [EXTENSION_RESET_PENDING_KEY]: marker } = await local.get(EXTENSION_RESET_PENDING_KEY);
  if (!marker) return false;
  const keepSyncPurge = typeof marker === "object" && "keepSyncPurge" in marker && marker.keepSyncPurge === true;
  await session.clear();
  const dataKeys = Object.keys(await local.get(null)).filter((key) =>
    key !== EXTENSION_RESET_PENDING_KEY && !(keepSyncPurge && key === BROWSER_SYNC_PENDING_PURGE_KEY)
  );
  if (dataKeys.length) await local.remove(dataKeys);
  await local.remove(EXTENSION_RESET_PENDING_KEY);
  return true;
}

export async function resetExtensionData(apis: ExtensionResetApis): Promise<void> {
  const operations = await apis.loadRequestOperations();
  if (apis.hasInFlightTasks() || operations.some((operation) => operation.state === "running")) {
    throw new Error("Wait for the current activation, refresh, sync, or status check to finish before resetting QuickPIM++.");
  }

  // A cloud outage must never trap local data. If the purge cannot be written,
  // retain a non-secret retry marker during the local reset; browser sync
  // refuses to apply remote data until that deletion succeeds.
  let pendingSyncPurge: ReturnType<typeof createBrowserSyncPurgeMarker> | undefined;
  try {
    await apis.purgeSyncedData();
  } catch (error) {
    pendingSyncPurge = createBrowserSyncPurgeMarker(error);
  }

  await Promise.allSettled([
    apis.closePortalRecoveryTabs(),
    apis.clearNotifications(),
    apis.removeNotificationPermission()
  ]);

  // Persist both markers together and retain them until the data is removed.
  // Startup can finish an interrupted reset without losing the cloud deletion.
  await apis.local.set({
    [EXTENSION_RESET_PENDING_KEY]: { version: 1, keepSyncPurge: Boolean(pendingSyncPurge) },
    ...(pendingSyncPurge ? { [BROWSER_SYNC_PENDING_PURGE_KEY]: pendingSyncPurge } : {})
  });
  await resumePendingExtensionReset(apis.local, apis.session);

  await Promise.allSettled([
    apis.clearAlarms(),
    apis.clearActionBadge()
  ]);
}
