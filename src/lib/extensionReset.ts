import type { RequestOperationRecord } from "./types";

export interface ExtensionResetApis {
  loadRequestOperations(): Promise<RequestOperationRecord[]>;
  hasInFlightTasks(): boolean;
  closePortalRecoveryTabs(): Promise<unknown>;
  clearNotifications(): Promise<void>;
  removeNotificationPermission(): Promise<unknown>;
  purgeSyncedData(): Promise<unknown>;
  queueSyncedDataPurge(error: unknown): Promise<void>;
  prepareResetRecovery(): Promise<void>;
  clearLocalStorage(): Promise<void>;
  clearSessionStorage(): Promise<void>;
  clearAlarms(): Promise<unknown>;
  clearActionBadge(): Promise<unknown>;
}

export const EXTENSION_RESET_PENDING_KEY = "quickPimResetPending.v1";

interface ResetStorageAreaLike {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  clear(): Promise<void>;
}

export async function resumePendingExtensionReset(
  local: ResetStorageAreaLike,
  session: Pick<ResetStorageAreaLike, "clear">
): Promise<boolean> {
  const result = await local.get(EXTENSION_RESET_PENDING_KEY);
  if (!result[EXTENSION_RESET_PENDING_KEY]) return false;
  await session.clear();
  await local.clear();
  return true;
}

export async function resetExtensionData(apis: ExtensionResetApis): Promise<void> {
  const operations = await apis.loadRequestOperations();
  if (apis.hasInFlightTasks() || operations.some((operation) => operation.state === "running")) {
    throw new Error("Wait for the current activation, refresh, sync, or status check to finish before resetting QuickPIM++.");
  }

  // A cloud outage must never trap local data. If the purge cannot be written,
  // retain only a non-secret retry marker after the local clear; browser sync
  // refuses to apply remote data until that deletion succeeds.
  let syncPurgeError: unknown;
  try {
    await apis.purgeSyncedData();
  } catch (error) {
    syncPurgeError = error;
  }

  await Promise.allSettled([
    apis.closePortalRecoveryTabs(),
    apis.clearNotifications(),
    apis.removeNotificationPermission()
  ]);

  // Persist intent before either storage area is touched. Session data is
  // cleared first so a local-clear failure leaves the durable marker behind;
  // startup can then finish the reset instead of exposing a half-reset state.
  await apis.prepareResetRecovery();
  await apis.clearSessionStorage();
  await apis.clearLocalStorage();

  if (syncPurgeError) {
    await apis.queueSyncedDataPurge(syncPurgeError);
  }

  await Promise.allSettled([
    apis.clearAlarms(),
    apis.clearActionBadge()
  ]);
}
