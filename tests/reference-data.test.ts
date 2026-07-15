import { describe, expect, test, vi } from "vitest";
import {
  DEFAULT_REFERENCE_DATA,
  REFERENCE_DATA_KEY,
  applyReferenceDataToItems,
  learnReferenceDataFromItems,
  mergeReferenceData,
  mergeReferenceDataForSave,
  saveReferenceData
} from "../src/lib/referenceData";
import { DEFAULT_SETTINGS, getDisplayName, getScopeLabel, mergeSettings } from "../src/lib/settings";
import type { ActivationItem } from "../src/lib/types";

const rawDirectoryRole: ActivationItem = {
  id: "directoryRole:reader:/",
  type: "directoryRole",
  sourceName: "reader",
  displayName: "reader",
  principalId: "user-1",
  roleDefinitionId: "reader",
  directoryScopeId: "/",
  scopeLabel: "Tenant",
  status: "eligible"
};

describe("reference data cache", () => {
  test("learns names from resolved items and applies alias, fresh, learned, raw precedence", () => {
    const learned = learnReferenceDataFromItems(DEFAULT_REFERENCE_DATA, [
      {
        ...rawDirectoryRole,
        sourceName: "Global Reader",
        displayName: "Global Reader"
      }
    ]);

    const withLearnedName = applyReferenceDataToItems([rawDirectoryRole], learned)[0];
    expect(withLearnedName.sourceName).toBe("reader");
    expect(getDisplayName(withLearnedName, DEFAULT_SETTINGS, learned)).toBe("Global Reader");
    expect(getDisplayName(rawDirectoryRole, DEFAULT_SETTINGS, learned)).toBe("Global Reader");

    const freshItem = { ...rawDirectoryRole, sourceName: "Fresh Reader", displayName: "Fresh Reader" };
    expect(getDisplayName(freshItem, DEFAULT_SETTINGS, learned)).toBe("Fresh Reader");

    const aliasedSettings = {
      ...DEFAULT_SETTINGS,
      aliasesByItemId: {
        [rawDirectoryRole.id]: "Local Alias"
      }
    };
    expect(getDisplayName(withLearnedName, aliasedSettings, learned)).toBe("Local Alias");

    expect(getDisplayName(rawDirectoryRole, DEFAULT_SETTINGS, DEFAULT_REFERENCE_DATA)).toBe("reader");
  });

  test("sanitizes imported reference data through count and length limits", () => {
    const imported = mergeReferenceData({
      directoryRoleDefinitions: {
        reader: { name: "x".repeat(200), updatedAt: "2026-05-18T12:00:00.000Z" },
        ["bad-key".repeat(80)]: { name: "Ignored", updatedAt: "2026-05-18T12:00:00.000Z" }
      },
      pimGroups: Object.fromEntries(
        Array.from({ length: 350 }, (_, index) => [
          `group-${index}`,
          { name: `Group ${index}`, updatedAt: "2026-05-18T12:00:00.000Z" }
        ])
      )
    });

    expect(imported.directoryRoleDefinitions.reader.name).toHaveLength(120);
    expect(imported.directoryRoleDefinitions).not.toHaveProperty("bad-key".repeat(80));
    expect(Object.keys(imported.pimGroups)).toHaveLength(300);
  });

  test("retains the newest learned names when a reference map exceeds its bound", () => {
    const imported = mergeReferenceData({
      pimGroups: Object.fromEntries(Array.from({ length: 301 }, (_, index) => [
        `group-${index}`,
        { name: `Group ${index}`, updatedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString() }
      ]))
    });
    expect(imported.pimGroups).not.toHaveProperty("group-0");
    expect(imported.pimGroups).toHaveProperty("group-300");
  });

  test("learns and reapplies directory scope names for admin units and devices", () => {
    const scopedRole: ActivationItem = {
      ...rawDirectoryRole,
      id: "directoryRole:reader:/administrativeUnits/au-1",
      directoryScopeId: "/administrativeUnits/au-1",
      scopeLabel: "Paris Devices"
    };
    const rawScopedRole: ActivationItem = {
      ...scopedRole,
      scopeLabel: "/administrativeUnits/au-1"
    };

    const learned = learnReferenceDataFromItems(DEFAULT_REFERENCE_DATA, [scopedRole]);

    expect(getScopeLabel(rawScopedRole, learned)).toBe("Paris Devices");
    expect(applyReferenceDataToItems([rawScopedRole], learned)[0]).toMatchObject({
      scopeLabel: "Paris Devices",
      sourceScopeLabel: "/administrativeUnits/au-1"
    });
  });

  test("keeps old settings import sanitization independent from reference data", () => {
    const settings = mergeSettings({
      aliasesByItemId: {
        [rawDirectoryRole.id]: "Alias"
      }
    });

    expect(settings.aliasesByItemId[rawDirectoryRole.id]).toBe("Alias");
  });

  test("merges concurrent learned names without replacing newer values", async () => {
    const older = "2026-05-18T10:00:00.000Z";
    const newer = "2026-05-18T11:00:00.000Z";
    expect(mergeReferenceDataForSave(
      {
        ...DEFAULT_REFERENCE_DATA,
        pimGroups: { "group-1": { name: "Current group", updatedAt: newer } }
      },
      {
        ...DEFAULT_REFERENCE_DATA,
        pimGroups: {
          "group-1": { name: "Stale group", updatedAt: older },
          "group-2": { name: "New group", updatedAt: newer }
        }
      }
    ).pimGroups).toEqual({
      "group-1": { name: "Current group", updatedAt: newer },
      "group-2": { name: "New group", updatedAt: newer }
    });

    const values: Record<string, unknown> = {};
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: values[key] })),
          set: vi.fn(async (items: Record<string, unknown>) => Object.assign(values, items)),
          remove: vi.fn(async (key: string) => {
            delete values[key];
          })
        }
      }
    });
    await Promise.all([
      saveReferenceData({
        ...DEFAULT_REFERENCE_DATA,
        directoryRoleDefinitions: { reader: { name: "Reader", updatedAt: older } }
      }),
      saveReferenceData({
        ...DEFAULT_REFERENCE_DATA,
        pimGroups: { "group-2": { name: "New group", updatedAt: newer } }
      })
    ]);
    expect(values[REFERENCE_DATA_KEY]).toMatchObject({
      directoryRoleDefinitions: { reader: { name: "Reader" } },
      pimGroups: { "group-2": { name: "New group" } }
    });
  });
});
