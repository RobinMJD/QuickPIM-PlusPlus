import type { RequestOperationRecord } from "./types";

export interface ExtensionResetApis {
  loadRequestOperations(): Promise<RequestOperationRecord[]>;
  hasInFlightTasks(): boolean;
  closePortalRecoveryTabs(): Promise<unknown>;
  clearNotifications(): Promise<void>;
  removeNotificationPermission(): Promise<unknown>;
  purgeSyncedData(): Promise<unknown>;
  clearLocalStorage(): Promise<void>;
  clearSessionStorage(): Promise<void>;
  clearAlarms(): Promise<unknown>;
  clearActionBadge(): Promise<unknown>;
}

export async function resetExtensionData(apis: ExtensionResetApis): Promise<void> {
  const operations = await apis.loadRequestOperations();
  if (apis.hasInFlightTasks() || operations.some((operation) => operation.state === "running")) {
    throw new Error("Wait for the current activation or deactivation to finish before resetting QuickPIM++.");
  }

  // A full reset must leave the browser-sync purge marker intact so another
  // installation or a stale sync generation cannot restore deleted data.
  await apis.purgeSyncedData();

  await Promise.allSettled([
    apis.closePortalRecoveryTabs(),
    apis.clearNotifications(),
    apis.removeNotificationPermission()
  ]);

  await Promise.all([
    apis.clearLocalStorage(),
    apis.clearSessionStorage()
  ]);

  await Promise.allSettled([
    apis.clearAlarms(),
    apis.clearActionBadge()
  ]);
}
