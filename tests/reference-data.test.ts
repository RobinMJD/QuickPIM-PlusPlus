import { describe, expect, test } from "vitest";
import {
  DEFAULT_REFERENCE_DATA,
  applyReferenceDataToItems,
  learnReferenceDataFromItems,
  mergeReferenceData
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
      scopeLabel: "Paris Devices"
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
});
