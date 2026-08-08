import { describe, expect, test } from "vitest";
import { buildSettingsExportFileName, validateSettingsBackup } from "../src/lib/settingsBackup";
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
});
