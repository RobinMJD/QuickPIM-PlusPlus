import { describe, expect, test } from "vitest";
import {
  DEFAULT_SETTINGS,
  mergeSettings,
  recordActivityResults,
  recordOperationActivity
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

  test("attributes activity and usage to a stable installation without double counting a reconciled operation", () => {
    const response: ActivationResponse = {
      success: true,
      results: [{ itemId: item.id, itemName: item.displayName, success: true, requestId: "request-1" }],
      errors: []
    };
    const input = {
      operationId: "operation-device-test",
      action: "activate" as const,
      items: [item],
      response,
      requestedAt: "2026-08-10T10:00:00.000Z",
      completedAt: "2026-08-10T10:00:01.000Z",
      durationHours: 1,
      source: { installationId: "12345678-abcd-efgh", deviceName: "Admin laptop" }
    };

    const first = recordOperationActivity(DEFAULT_SETTINGS, input);
    const replayed = recordOperationActivity(first, input);

    expect(replayed.activityHistory).toHaveLength(1);
    expect(replayed.activityHistory[0]).toMatchObject({
      sourceInstallationId: "12345678-abcd-efgh",
      sourceDeviceName: "Admin laptop"
    });
    expect(replayed.usageStatsByItemId[item.id]).toMatchObject({
      activationCount: 1,
      byInstallationId: {
        "12345678-abcd-efgh": { activationCount: 1 }
      }
    });
  });

  test("persists and deduplicates activity for Azure item IDs longer than 256 characters", () => {
    const longScope = `/subscriptions/subscription-id/resourceGroups/${"scope".repeat(70)}`;
    const azureItem: ActivationItem = {
      id: `azureRole:reader:${longScope}`,
      type: "azureRole",
      sourceName: "Reader",
      displayName: "Reader",
      principalId: "user-1",
      roleDefinitionId: "reader",
      scope: longScope,
      scopeLabel: "Long Azure resource scope",
      status: "eligible"
    };
    expect(azureItem.id.length).toBeGreaterThan(256);
    expect(azureItem.id.length).toBeLessThanOrEqual(512);
    const response: ActivationResponse = {
      success: true,
      results: [{ itemId: azureItem.id, itemName: azureItem.displayName, success: true }],
      errors: []
    };
    const input = {
      operationId: "operation-long-azure-scope",
      action: "activate" as const,
      items: [azureItem],
      response,
      requestedAt: "2026-08-10T10:00:00.000Z",
      completedAt: "2026-08-10T10:00:01.000Z",
      source: { installationId: "long-scope-device", deviceName: "Azure admin PC" }
    };

    const persisted = mergeSettings(recordOperationActivity(DEFAULT_SETTINGS, input));
    const replayed = mergeSettings(recordOperationActivity(persisted, input));

    expect(replayed.activityHistory).toHaveLength(1);
    expect(replayed.activityHistory[0].id.length).toBeLessThanOrEqual(256);
    expect(replayed.activityHistory[0].itemId).toBe(azureItem.id);
    expect(replayed.usageStatsByItemId[azureItem.id].activationCount).toBe(1);
  });

  test("records a thrown-operation failure with its source without incrementing usage", () => {
    const failedResponse: ActivationResponse = {
      success: false,
      results: [{ itemId: item.id, itemName: item.displayName, success: false, error: "Network request failed" }],
      errors: [{ itemId: item.id, itemName: item.displayName, success: false, error: "Network request failed" }]
    };
    const input = {
      operationId: "operation-network-failure",
      action: "activate" as const,
      items: [item],
      response: failedResponse,
      requestedAt: "2026-08-10T10:00:00.000Z",
      completedAt: "2026-08-10T10:00:01.000Z",
      source: { installationId: "failure-device", deviceName: "Operations PC" }
    };

    const first = recordOperationActivity(DEFAULT_SETTINGS, input);
    const replayed = recordOperationActivity(first, input);

    expect(replayed.activityHistory).toEqual([
      expect.objectContaining({
        result: "failed",
        sourceInstallationId: "failure-device",
        sourceDeviceName: "Operations PC"
      })
    ]);
    expect(replayed.usageStatsByItemId).toEqual({});
  });
});
