import { mergeImportedSettings } from "./settings";
import type { QuickPimSettings } from "./types";

export const MAX_SETTINGS_BACKUP_BYTES = 1024 * 1024;

export interface SettingsBackupValidation {
  settings?: QuickPimSettings;
  error?: string;
}

export function validateSettingsBackup(text: string, current: QuickPimSettings): SettingsBackupValidation {
  if (!text.trim()) {
    return { error: "Settings JSON cannot be empty." };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isSettingsImportObject(parsed)) {
      return { error: "JSON must contain at least one recognized QuickPIM++ settings section." };
    }
    return { settings: mergeImportedSettings(current, parsed) };
  } catch (parseError) {
    return { error: parseError instanceof Error ? `Invalid JSON: ${parseError.message}` : "Invalid JSON." };
  }
}

export function buildSettingsExportFileName(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `quickpim-plusplus-settings_${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.json`;
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
    "preferences"
  ].some((key) => keys.has(key));
}
