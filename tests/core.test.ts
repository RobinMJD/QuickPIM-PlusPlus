import { describe, expect, test } from "vitest";
import {
  DEFAULT_SETTINGS,
  addRecentJustification,
  createActivationHistoryEntries,
  expandBundle,
  getDisplayName,
  recordActivations,
  sortItems
} from "../src/lib/settings";
import {
  buildActivationRequest,
  durationHoursToIso,
  normalizeAzureRole,
  normalizeDirectoryRole,
  normalizePimGroup
} from "../src/lib/pim";
import type { ActivationItem, QuickPimBundle, QuickPimSettings } from "../src/lib/types";

const baseSettings: QuickPimSettings = {
  ...DEFAULT_SETTINGS,
  aliasesByItemId: {
    "directoryRole:reader:/": "Tenant reader alias"
  },
  usageStatsByItemId: {
    "directoryRole:reader:/": {
      activationCount: 3,
      lastUsedAt: "2026-05-17T10:00:00.000Z"
    },
    "pimGroup:group-1:member": {
      activationCount: 1,
      lastUsedAt: "2026-05-18T10:00:00.000Z"
    }
  }
};

describe("PIM item normalization", () => {
  test("normalizes directory roles with alias-ready stable ids", () => {
    const item = normalizeDirectoryRole({
      roleDefinitionId: "reader",
      principalId: "user-1",
      directoryScopeId: "/",
      roleName: "Global Reader"
    });

    expect(item).toMatchObject({
      id: "directoryRole:reader:/",
      type: "directoryRole",
      sourceName: "Global Reader",
      displayName: "Global Reader",
      principalId: "user-1",
      directoryScopeId: "/"
    });
  });

  test("normalizes Azure roles with expanded display names and eligibility schedule ids", () => {
    const item = normalizeAzureRole({
      id: "/subscriptions/sub-1/providers/Microsoft.Authorization/RoleEligibilityScheduleInstances/elig-1",
      name: "elig-1",
      subscriptionId: "sub-1",
      subscriptionName: "Production",
      properties: {
        principalId: "user-1",
        roleDefinitionId: "/subscriptions/sub-1/providers/Microsoft.Authorization/roleDefinitions/contributor",
        roleEligibilityScheduleId: "/subscriptions/sub-1/providers/Microsoft.Authorization/roleEligibilitySchedules/schedule-1",
        scope: "/subscriptions/sub-1/resourceGroups/rg-app",
        expandedProperties: {
          roleDefinition: {
            displayName: "Contributor"
          },
          scope: {
            displayName: "rg-app",
            type: "resourcegroup"
          }
        }
      }
    });

    expect(item).toMatchObject({
      id: "azureRole:/subscriptions/sub-1/providers/Microsoft.Authorization/roleDefinitions/contributor:/subscriptions/sub-1/resourceGroups/rg-app",
      type: "azureRole",
      sourceName: "Contributor",
      scopeLabel: "Production / rg-app",
      roleEligibilityScheduleId: "/subscriptions/sub-1/providers/Microsoft.Authorization/roleEligibilitySchedules/schedule-1"
    });
  });

  test("normalizes PIM groups for both member and owner access", () => {
    const item = normalizePimGroup(
      {
        groupId: "group-1",
        principalId: "user-1",
        accessId: "owner",
        memberType: "direct"
      },
      {
        displayName: "Break Glass Operators"
      }
    );

    expect(item).toMatchObject({
      id: "pimGroup:group-1:owner",
      type: "pimGroup",
      sourceName: "Break Glass Operators",
      accessId: "owner",
      groupId: "group-1",
      scopeLabel: "Owner"
    });
  });
});

describe("settings helpers", () => {
  const items: ActivationItem[] = [
    {
      id: "directoryRole:reader:/",
      type: "directoryRole",
      sourceName: "Global Reader",
      displayName: "Global Reader",
      principalId: "user-1",
      roleDefinitionId: "reader",
      directoryScopeId: "/",
      scopeLabel: "Tenant",
      status: "eligible"
    },
    {
      id: "pimGroup:group-1:member",
      type: "pimGroup",
      sourceName: "Break Glass Operators",
      displayName: "Break Glass Operators",
      principalId: "user-1",
      groupId: "group-1",
      accessId: "member",
      scopeLabel: "Member",
      status: "eligible"
    }
  ];

  test("manual aliases override API names", () => {
    expect(getDisplayName(items[0], baseSettings)).toBe("Tenant reader alias");
    expect(getDisplayName(items[1], baseSettings)).toBe("Break Glass Operators");
  });

  test("sorts by name, last use, and activation count", () => {
    expect(sortItems(items, baseSettings, "name").map((item) => item.id)).toEqual([
      "pimGroup:group-1:member",
      "directoryRole:reader:/"
    ]);
    expect(sortItems(items, baseSettings, "lastUsed").map((item) => item.id)).toEqual([
      "pimGroup:group-1:member",
      "directoryRole:reader:/"
    ]);
    expect(sortItems(items, baseSettings, "activationCount").map((item) => item.id)).toEqual([
      "directoryRole:reader:/",
      "pimGroup:group-1:member"
    ]);
  });

  test("maintains de-duplicated recent justifications with saved templates separate", () => {
    const updated = addRecentJustification(
      {
        ...baseSettings,
        recentJustifications: ["Access incident", "Daily admin"],
        savedJustifications: ["Patch window"]
      },
      "Daily admin"
    );

    expect(updated.recentJustifications).toEqual(["Daily admin", "Access incident"]);
    expect(updated.savedJustifications).toEqual(["Patch window"]);
  });

  test("expands bundles and preserves default activation fields", () => {
    const bundle: QuickPimBundle = {
      id: "bundle-1",
      name: "Daily ops",
      itemIds: ["directoryRole:reader:/", "pimGroup:group-1:member"],
      defaultDurationHours: 2,
      defaultJustification: "Daily operations",
      defaultTicketSystem: "Jira",
      defaultTicketNumber: "OPS-1"
    };

    expect(expandBundle(bundle, items)).toMatchObject({
      items,
      durationHours: 2,
      justification: "Daily operations",
      ticketInfo: {
        ticketSystem: "Jira",
        ticketNumber: "OPS-1"
      }
    });
  });

  test("records activation usage and history entries", () => {
    const now = "2026-05-18T12:00:00.000Z";
    const updated = recordActivations(baseSettings, items, now);
    expect(updated.usageStatsByItemId["directoryRole:reader:/"]).toEqual({
      activationCount: 4,
      lastUsedAt: now
    });

    const history = createActivationHistoryEntries(items, "Daily ops", now);
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({
      itemId: "directoryRole:reader:/",
      bundleName: "Daily ops",
      activatedAt: now
    });
  });
});

describe("activation request builders", () => {
  test("converts fractional hours to ISO-8601 minute durations", () => {
    expect(durationHoursToIso(1.5)).toBe("PT90M");
  });

  test("builds directory, Azure, and PIM group activation payloads", () => {
    const startDateTime = "2026-05-18T12:00:00.000Z";
    const ticketInfo = { ticketSystem: "Jira", ticketNumber: "OPS-1" };

    expect(
      buildActivationRequest(
        {
          id: "directoryRole:reader:/",
          type: "directoryRole",
          sourceName: "Global Reader",
          displayName: "Global Reader",
          principalId: "user-1",
          roleDefinitionId: "reader",
          directoryScopeId: "/",
          scopeLabel: "Tenant",
          status: "eligible"
        },
        2,
        "Need access",
        ticketInfo,
        startDateTime
      )
    ).toMatchObject({
      endpoint: "https://graph.microsoft.com/v1.0/roleManagement/directory/roleAssignmentScheduleRequests",
      method: "POST",
      tokenKind: "graph",
      body: {
        action: "selfActivate",
        roleDefinitionId: "reader",
        directoryScopeId: "/"
      }
    });

    expect(
      buildActivationRequest(
        {
          id: "azureRole:contributor:/subscriptions/sub-1",
          type: "azureRole",
          sourceName: "Contributor",
          displayName: "Contributor",
          principalId: "user-1",
          roleDefinitionId: "/subscriptions/sub-1/providers/Microsoft.Authorization/roleDefinitions/contributor",
          roleEligibilityScheduleId: "schedule-1",
          scope: "/subscriptions/sub-1",
          scopeLabel: "Production",
          status: "eligible"
        },
        2,
        "Need access",
        ticketInfo,
        startDateTime,
        "request-1"
      )
    ).toMatchObject({
      endpoint:
        "https://management.azure.com/subscriptions/sub-1/providers/Microsoft.Authorization/roleAssignmentScheduleRequests/request-1?api-version=2020-10-01",
      method: "PUT",
      tokenKind: "azureManagement",
      body: {
        properties: {
          requestType: "SelfActivate",
          linkedRoleEligibilityScheduleId: "schedule-1"
        }
      }
    });

    expect(
      buildActivationRequest(
        {
          id: "pimGroup:group-1:member",
          type: "pimGroup",
          sourceName: "Break Glass Operators",
          displayName: "Break Glass Operators",
          principalId: "user-1",
          groupId: "group-1",
          accessId: "member",
          scopeLabel: "Member",
          status: "eligible"
        },
        2,
        "Need access",
        ticketInfo,
        startDateTime
      )
    ).toMatchObject({
      endpoint: "https://graph.microsoft.com/v1.0/identityGovernance/privilegedAccess/group/assignmentScheduleRequests",
      method: "POST",
      tokenKind: "graph",
      body: {
        action: "selfActivate",
        accessId: "member",
        groupId: "group-1"
      }
    });
  });
});
