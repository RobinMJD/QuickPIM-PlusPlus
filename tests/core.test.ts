import { describe, expect, test } from "vitest";
import {
  DEFAULT_SETTINGS,
  addRecentJustification,
  createActivationHistoryEntries,
  expandBundle,
  getDisplayName,
  mergeSettings,
  recordActivations,
  sortItems
} from "../src/lib/settings";
import {
  buildActivationRequest,
  buildRolePolicyRequirementMap,
  extractActivationRequirementsFromPolicyRules,
  durationHoursToIso,
  getActiveUntilFromScheduleInfo,
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

  test("normalizes directory role scope display names when available", () => {
    const item = normalizeDirectoryRole({
      roleDefinitionId: "groups-admin",
      principalId: "user-1",
      directoryScopeId: "/administrativeUnits/au-1",
      directoryScopeDisplayName: "Paris Devices",
      roleName: "Groups Administrator"
    });

    expect(item).toMatchObject({
      id: "directoryRole:groups-admin:/administrativeUnits/au-1",
      scopeLabel: "Paris Devices"
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
      id: "azureRole:contributor:/subscriptions/sub-1/resourceGroups/rg-app",
      type: "azureRole",
      sourceName: "Contributor",
      scopeLabel: "Production / rg-app",
      roleEligibilityScheduleId: "/subscriptions/sub-1/providers/Microsoft.Authorization/roleEligibilitySchedules/schedule-1"
    });
  });

  test("normalizes inherited Azure management group roles without subscription duplication", () => {
    const item = normalizeAzureRole({
      id: "/subscriptions/sub-1/providers/Microsoft.Authorization/RoleEligibilityScheduleInstances/elig-1",
      name: "elig-1",
      subscriptionId: "sub-1",
      subscriptionName: "FR_HQ_AzDevOps_PRD01_SUB",
      properties: {
        principalId: "user-1",
        roleDefinitionId: "/subscriptions/sub-1/providers/Microsoft.Authorization/roleDefinitions/acdd72a7-3385-48ef-bd42-f606fba81ae7",
        roleEligibilityScheduleId: "/providers/Microsoft.Authorization/roleEligibilitySchedules/root-reader",
        scope: "/providers/Microsoft.Management/managementGroups/tenant-root",
        expandedProperties: {
          roleDefinition: {
            displayName: "Reader"
          },
          scope: {
            displayName: "Tenant Root Group",
            type: "managementgroup"
          }
        }
      }
    });

    expect(item).toMatchObject({
      id: "azureRole:acdd72a7-3385-48ef-bd42-f606fba81ae7:/providers/Microsoft.Management/managementGroups/tenant-root",
      scopeLabel: "Tenant Root Group"
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

  test("extracts activation maximum duration from PIM policy rules", () => {
    expect(
      extractActivationRequirementsFromPolicyRules([
        {
          id: "Expiration_EndUser_Assignment",
          maximumDuration: "PT4H",
          target: {
            caller: "EndUser",
            level: "Assignment"
          }
        },
        {
          id: "Enablement_EndUser_Assignment",
          enabledRules: ["Justification", "Ticketing"],
          target: {
            caller: "EndUser",
            level: "Assignment"
          }
        }
      ])
    ).toEqual({
      justification: true,
      ticket: true,
      maxDurationHours: 4
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

  test("places favorite roles before other items for every sort mode", () => {
    const favoriteSettings: QuickPimSettings = {
      ...baseSettings,
      favoriteItemIds: ["directoryRole:reader:/"]
    };

    expect(sortItems(items, favoriteSettings, "lastUsed").map((item) => item.id)).toEqual([
      "directoryRole:reader:/",
      "pimGroup:group-1:member"
    ]);
    expect(sortItems(items, favoriteSettings, "name").map((item) => item.id)).toEqual([
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
      defaultJustification: "Daily operations"
    };

    expect(expandBundle(bundle, items)).toMatchObject({
      items,
      durationHours: 2,
      justification: "Daily operations",
      ticketInfo: {}
    });
  });

  test("drops obsolete ticket defaults from imported bundles", () => {
    const imported = mergeSettings({
      bundles: [
        {
          id: "bundle-1",
          name: "Daily ops",
          itemIds: ["directoryRole:reader:/"],
          defaultTicketSystem: "Jira",
          defaultTicketNumber: "OPS-1"
        } as QuickPimBundle
      ]
    });

    expect(imported.bundles[0]).not.toHaveProperty("defaultTicketSystem");
    expect(imported.bundles[0]).not.toHaveProperty("defaultTicketNumber");
    expect(expandBundle(imported.bundles[0], items).ticketInfo).toEqual({});
  });

  test("bundle expansion skips already active items", () => {
    const bundle: QuickPimBundle = {
      id: "bundle-1",
      name: "Daily ops",
      itemIds: ["directoryRole:reader:/", "pimGroup:group-1:member"]
    };

    expect(expandBundle(bundle, [{ ...items[0], status: "active" }, items[1]]).items).toEqual([items[1]]);
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

  test("sanitizes imported settings instead of trusting arbitrary persisted shapes", () => {
    const imported = mergeSettings({
      aliasesByItemId: {
        "directoryRole:reader:/": "x".repeat(180),
        ["bad-key".repeat(80)]: "Ignored"
      },
      savedJustifications: ["Patch window", "Patch window", "x".repeat(2000)],
      recentJustifications: ["Recent work", "x".repeat(2000)],
      favoriteItemIds: ["directoryRole:reader:/", "x".repeat(400), "directoryRole:reader:/"],
      bundles: [
        {
          id: "bundle:unsafe",
          name: "x".repeat(120),
          itemIds: Array.from({ length: 140 }, (_, index) => `item-${index}`),
          defaultDurationHours: 99,
          defaultJustification: "x".repeat(2000)
        }
      ],
      preferences: {
        defaultDurationHours: 99,
        defaultSort: "invalid" as any,
        recentJustificationLimit: 99,
        darkMode: true,
        hiddenPopupTabs: ["azureRole", "bundles", "unknown" as any, "azureRole"]
      }
    });

    expect(imported.aliasesByItemId["directoryRole:reader:/"]).toHaveLength(120);
    expect(imported.aliasesByItemId).not.toHaveProperty("bad-key".repeat(80));
    expect(imported.savedJustifications).toHaveLength(2);
    expect(imported.savedJustifications[1]).toHaveLength(1024);
    expect(imported.recentJustifications[1]).toHaveLength(1024);
    expect(imported.favoriteItemIds).toEqual(["directoryRole:reader:/"]);
    expect(imported.bundles[0].name).toHaveLength(80);
    expect(imported.bundles[0].itemIds).toHaveLength(100);
    expect(imported.bundles[0].defaultDurationHours).toBe(24);
    expect(imported.bundles[0].defaultJustification).toHaveLength(1024);
    expect(imported.bundles[0]).not.toHaveProperty("defaultTicketSystem");
    expect(imported.bundles[0]).not.toHaveProperty("defaultTicketNumber");
    expect(imported.preferences).toMatchObject({
      defaultDurationHours: 24,
      defaultSort: "name",
      recentJustificationLimit: 20,
      darkMode: true,
      hiddenPopupTabs: ["azureRole", "bundles"]
    });
  });
});

describe("activation request builders", () => {
  test("computes active end time from schedule info", () => {
    expect(
      getActiveUntilFromScheduleInfo({
        startDateTime: "2026-05-18T12:00:00.000Z",
        expiration: {
          duration: "PT2H"
        }
      })
    ).toBe("2026-05-18T14:00:00.000Z");
    expect(
      getActiveUntilFromScheduleInfo({
        expiration: {
          endDateTime: "2026-05-18T15:00:00.000Z"
        }
      })
    ).toBe("2026-05-18T15:00:00.000Z");
  });

  test("maps policy requirements by full id, leaf id, and member owner aliases", () => {
    const requirements = buildRolePolicyRequirementMap([
      {
        roleDefinitionId: "/subscriptions/sub-1/providers/Microsoft.Authorization/roleDefinitions/contributor",
        policy: {
          rules: [
            {
              id: "Expiration_EndUser_Assignment",
              maximumDuration: "PT4H",
              target: { caller: "EndUser", level: "Assignment" }
            }
          ]
        }
      },
      {
        id: "group-member-policy",
        properties: {
          roleDefinitionId: "member",
          policy: {
            rules: [
              {
                id: "Expiration_EndUser_Assignment",
                maximumDuration: "PT2H",
                target: { caller: "EndUser", level: "Assignment" }
              }
            ]
          }
        }
      }
    ]);

    expect(requirements["/subscriptions/sub-1/providers/microsoft.authorization/roledefinitions/contributor"]).toMatchObject({
      maxDurationHours: 4
    });
    expect(requirements.contributor).toMatchObject({ maxDurationHours: 4 });
    expect(requirements.member).toMatchObject({ maxDurationHours: 2 });
    expect(requirements["group-member-policy"]).toMatchObject({ maxDurationHours: 2 });
  });

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

  test("appends the QuickPIM++ marker only to outbound activation payload justifications", () => {
    const directoryRequest = buildActivationRequest(
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
      1,
      "Need access"
    );
    const azureRequest = buildActivationRequest(
      {
        id: "azureRole:reader:/subscriptions/sub-1",
        type: "azureRole",
        sourceName: "Reader",
        displayName: "Reader",
        principalId: "user-1",
        roleDefinitionId: "/subscriptions/sub-1/providers/Microsoft.Authorization/roleDefinitions/reader",
        scope: "/subscriptions/sub-1",
        scopeLabel: "Production",
        status: "eligible"
      },
      1,
      "Need access"
    );
    const groupRequest = buildActivationRequest(
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
      1,
      "Need access"
    );

    expect(directoryRequest.body).toMatchObject({
      justification: "Need access {Activated using QuickPIM++}"
    });
    expect((azureRequest.body.properties as Record<string, unknown>).justification).toBe(
      "Need access {Activated using QuickPIM++}"
    );
    expect(groupRequest.body).toMatchObject({
      justification: "Need access {Activated using QuickPIM++}"
    });
  });

  test("allows Azure management group scopes for activation payloads", () => {
    const request = buildActivationRequest(
      {
        id: "azureRole:reader:/providers/Microsoft.Management/managementGroups/tenant-root",
        type: "azureRole",
        sourceName: "Reader",
        displayName: "Reader",
        principalId: "user-1",
        roleDefinitionId: "/providers/Microsoft.Authorization/roleDefinitions/acdd72a7-3385-48ef-bd42-f606fba81ae7",
        scope: "/providers/Microsoft.Management/managementGroups/tenant-root",
        scopeLabel: "Tenant Root Group",
        status: "eligible"
      },
      1,
      "Admin task",
      {},
      "2026-05-18T12:00:00.000Z",
      "request-1"
    );

    expect(request.endpoint).toBe(
      "https://management.azure.com/providers/Microsoft.Management/managementGroups/tenant-root/providers/Microsoft.Authorization/roleAssignmentScheduleRequests/request-1?api-version=2020-10-01"
    );
  });
});
