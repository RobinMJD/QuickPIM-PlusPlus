import { describe, expect, test } from "vitest";
import {
  DEFAULT_SETTINGS,
  mergeSettings,
  recordActivityResults
} from "../src/lib/settings";
import type { ActivationItem, ActivationResponse, QuickPimSettings } from "../src/lib/types";

const item: ActivationItem = {
  id: "directoryRole:reader:/",
  type: "directoryRole",
  sourceName: "Reader",
  displayName: "Reader",
  principalId: "user-1",
  roleDefinitionId: "reader",
  directoryScopeId: "/",
  scopeLabel: "Tenant",
  status: "eligible"
};

describe("activity history", () => {
  test("records activation and deactivation result activity with sanitized local fields", () => {
    const response: ActivationResponse = {
      success: false,
      results: [
        { itemId: item.id, itemName: item.displayName, success: true },
        { itemId: "missing", itemName: "Missing", success: false, error: "Bearer abc.def.ghi failed" }
      ],
      errors: [{ itemId: "missing", itemName: "Missing", success: false, error: "Bearer abc.def.ghi failed" }]
    };

    const settings = recordActivityResults(DEFAULT_SETTINGS, {
      action: "activate",
      items: [item],
      response,
      requestedAt: "2026-05-18T12:00:00.000Z",
      completedAt: "2026-05-18T12:01:00.000Z",
      durationHours: 1,
      justification: "Need access for incident INC001",
      bundleName: "Ops"
    });

    expect(settings.activityHistory).toHaveLength(2);
    expect(settings.activityHistory[0]).toMatchObject({
      action: "activate",
      result: "success",
      itemName: "Reader",
      durationHours: 1,
      bundleName: "Ops"
    });
    expect(settings.activityHistory[1].error).toContain("[redacted token]");
  });

  test("migrates legacy activationHistory entries into activityHistory", () => {
    const merged = mergeSettings({
      version: 1,
      activationHistory: [
        {
          id: "old",
          itemId: item.id,
          itemName: "Reader",
          itemType: "directoryRole",
          activatedAt: "2026-05-18T12:00:00.000Z"
        }
      ]
    } as unknown as Partial<QuickPimSettings>);

    expect(merged.version).toBe(2);
    expect(merged.activityHistory[0]).toMatchObject({
      id: "old",
      action: "activate",
      result: "success",
      itemName: "Reader",
      requestedAt: "2026-05-18T12:00:00.000Z"
    });
  });
});
