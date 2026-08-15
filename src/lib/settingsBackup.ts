import { DEFAULT_SETTINGS, mergeImportedSettings, mergeSettings } from "./settings";
import { sanitizeTrackedRequestStore } from "./requestTracking";
import type { QuickPimSettings, TrackedPimRequestStore } from "./types";

export const MAX_SETTINGS_BACKUP_BYTES = 1024 * 1024;

export interface SettingsBackupValidation {
  settings?: QuickPimSettings;
  trackedRequests?: TrackedPimRequestStore;
  error?: string;
}

export function validateSettingsBackup(
  text: string,
  current: QuickPimSettings,
  currentTrackedRequests: TrackedPimRequestStore = { version: 1, requests: [] }
): SettingsBackupValidation {
  if (!text.trim()) {
    return { error: "Settings JSON cannot be empty." };
  }
  if (text.length > MAX_SETTINGS_BACKUP_BYTES || new TextEncoder().encode(text).length > MAX_SETTINGS_BACKUP_BYTES) {
    return { error: "Settings JSON must be 1 MiB or smaller." };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isSettingsImportObject(parsed)) {
      return { error: "JSON must contain at least one recognized QuickPIM++ settings section." };
    }
    const parsedRecord = parsed as Record<string, unknown>;
    return {
      settings: mergeImportedSettings(current, parsedRecord),
      trackedRequests: Object.hasOwn(parsedRecord, "trackedRequests")
        ? sanitizeTrackedRequestStore(parsedRecord.trackedRequests)
        : sanitizeTrackedRequestStore(currentTrackedRequests)
    };
  } catch (parseError) {
    return { error: parseError instanceof Error ? `Invalid JSON: ${parseError.message}` : "Invalid JSON." };
  }
}

export function buildSettingsExportFileName(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `quickpim-plusplus-settings_${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.json`;
}

export function stringifySettingsBackup(
  settings: QuickPimSettings,
  trackedRequests: TrackedPimRequestStore = { version: 1, requests: [] }
): string {
  return JSON.stringify({
    ...mergeSettings(settings),
    trackedRequests: sanitizeTrackedRequestStore(trackedRequests)
  }, null, 2);
}

export function hasPortableSettingsData(
  settings: QuickPimSettings,
  trackedRequests: TrackedPimRequestStore = { version: 1, requests: [] }
): boolean {
  const normalized = mergeSettings(settings);
  const preferences = {
    ...normalized.preferences,
    autoEnabledFeaturesInitialized: DEFAULT_SETTINGS.preferences.autoEnabledFeaturesInitialized
  };
  return Boolean(
    Object.keys(normalized.aliasesByItemId).length
    || normalized.favoriteItemIds.length
    || normalized.savedJustifications.length
    || normalized.recentJustifications.length
    || normalized.bundles.length
    || Object.keys(normalized.usageStatsByItemId).length
    || normalized.activityHistory.length
    || normalized.activationHistory.length
    || JSON.stringify(preferences) !== JSON.stringify(DEFAULT_SETTINGS.preferences)
    || sanitizeTrackedRequestStore(trackedRequests).requests.length
  );
}

function isSettingsImportObject(value: unknown): value is Partial<QuickPimSettings> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const keys = new Set(Object.keys(value));
  return [
    "aliasesByItemId",
    "favoriteItemIds",
    "savedJustifications",
    "recentJustifications",
    "bundles",
    "usageStatsByItemId",
    "activityHistory",
    "preferences",
    "trackedRequests"
  ].some((key) => keys.has(key));
}
