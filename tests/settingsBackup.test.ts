import { describe, expect, test } from "vitest";
import {
  MAX_SETTINGS_BACKUP_BYTES,
  buildSettingsExportFileName,
  hasPortableSettingsData,
  stringifySettingsBackup,
  validateSettingsBackup
} from "../src/lib/settingsBackup";
import { DEFAULT_SETTINGS } from "../src/lib/settings";

describe("settings backup", () => {
  test("uses the exact local timestamped export filename", () => {
    const date = new Date(2026, 7, 8, 14, 32, 5);
    expect(buildSettingsExportFileName(date)).toBe("quickpim-plusplus-settings_20260808-143205.json");
  });

  test("merges partial settings backups without replacing unrelated values", () => {
    const current = structuredClone(DEFAULT_SETTINGS);
    current.savedJustifications = ["Keep this reason"];
    current.preferences.darkMode = false;

    const result = validateSettingsBackup('{"preferences":{"darkMode":true}}', current);

    expect(result.error).toBeUndefined();
    expect(result.settings?.preferences.darkMode).toBe(true);
    expect(result.settings?.savedJustifications).toEqual(["Keep this reason"]);
  });

  test("rejects empty, invalid, and unrecognized JSON", () => {
    expect(validateSettingsBackup("", DEFAULT_SETTINGS).error).toBe("Settings JSON cannot be empty.");
    expect(validateSettingsBackup("{", DEFAULT_SETTINGS).error).toContain("Invalid JSON:");
    expect(validateSettingsBackup('{"unknown":true}', DEFAULT_SETTINGS).error).toContain("recognized QuickPIM++ settings section");
  });

  test("rejects oversized pasted JSON before parsing", () => {
    const oversized = `{"savedJustifications":["${"x".repeat(MAX_SETTINGS_BACKUP_BYTES)}"]}`;
    expect(validateSettingsBackup(oversized, DEFAULT_SETTINGS).error).toBe("Settings JSON must be 1 MiB or smaller.");
    const oversizedUtf8 = `{"savedJustifications":["${"é".repeat(Math.ceil(MAX_SETTINGS_BACKUP_BYTES / 2))}"]}`;
    expect(validateSettingsBackup(oversizedUtf8, DEFAULT_SETTINGS).error).toBe("Settings JSON must be 1 MiB or smaller.");
  });

  test("drops prototype-sensitive keys from imported records", () => {
    const result = validateSettingsBackup(`{
      "aliasesByItemId": {
        "directoryRole:safe:/": "Safe alias",
        "__proto__": "ignored",
        "constructor": "ignored",
        "prototype": "ignored"
      },
      "usageStatsByItemId": {
        "directoryRole:safe:/": { "activationCount": 1 },
        "constructor": { "activationCount": 99 }
      }
    }`, DEFAULT_SETTINGS);

    expect(result.error).toBeUndefined();
    expect(result.settings?.aliasesByItemId).toEqual({ "directoryRole:safe:/": "Safe alias" });
    expect(result.settings?.usageStatsByItemId).toEqual({
      "directoryRole:safe:/": { activationCount: 1, legacyActivationCount: 1 }
    });
  });

  test("offers migration backup only when portable settings or history changed", () => {
    expect(hasPortableSettingsData(structuredClone(DEFAULT_SETTINGS))).toBe(false);
    expect(hasPortableSettingsData({
      ...structuredClone(DEFAULT_SETTINGS),
      preferences: {
        ...DEFAULT_SETTINGS.preferences,
        autoEnabledFeaturesInitialized: true
      }
    })).toBe(false);
    const used = {
      ...structuredClone(DEFAULT_SETTINGS),
      savedJustifications: ["Approved change CHG0001"]
    };
    expect(hasPortableSettingsData(used)).toBe(true);
    expect(JSON.parse(stringifySettingsBackup(used)).savedJustifications).toEqual(["Approved change CHG0001"]);
  });

  test("round-trips portable data and preserves disabled feature tabs", () => {
    const configured = structuredClone(DEFAULT_SETTINGS);
    configured.aliasesByItemId = { "directoryRole:role-1:/": "Daily admin" };
    configured.favoriteItemIds = ["directoryRole:role-1:/"];
    configured.savedJustifications = ["Approved maintenance CHG0001"];
    configured.recentJustifications = ["Investigate incident INC0001"];
    configured.bundles = [{
      id: "bundle-1",
      name: "Daily bundle",
      itemIds: ["directoryRole:role-1:/"],
      defaultDurationHours: 1,
      defaultJustification: "Approved maintenance CHG0001"
    }];
    configured.usageStatsByItemId = {
      "directoryRole:role-1:/": { activationCount: 3, legacyActivationCount: 3 }
    };
    configured.activityHistory = [{
      id: "activity-1",
      action: "activate",
      itemId: "directoryRole:role-1:/",
      itemName: "Application Administrator",
      itemType: "directoryRole",
      scopeLabel: "Tenant",
      result: "success",
      requestedAt: "2026-08-10T10:00:00.000Z",
      completedAt: "2026-08-10T10:00:01.000Z"
    }];
    configured.preferences.enabledFeatures = ["directoryRole", "pimGroup", "bundles"];
    configured.preferences.autoEnabledFeaturesInitialized = true;

    const restored = validateSettingsBackup(
      stringifySettingsBackup(configured),
      structuredClone(DEFAULT_SETTINGS)
    );

    expect(restored.error).toBeUndefined();
    expect(restored.settings).toEqual(configured);
    expect(restored.settings?.preferences.enabledFeatures).not.toContain("azureRole");
  });
});
