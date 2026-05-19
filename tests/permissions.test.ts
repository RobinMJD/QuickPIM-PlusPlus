import { describe, expect, test } from "vitest";
import {
  REQUIRED_PERMISSION_ITEMS,
  buildPermissionStatus,
  getMissingPermissionItems,
  permissionSetupPowerShell,
  shouldShowPermissionWarning
} from "../src/lib/permissions";
import { DEFAULT_SETTINGS } from "../src/lib/settings";
import type { TokenStatus } from "../src/lib/types";

const fullTokenStatus: TokenStatus = {
  graph: {
    hasToken: true,
    isExpired: false,
    tokenAge: 1,
    grantedScopes: [
      "RoleEligibilitySchedule.Read.Directory",
      "RoleAssignmentSchedule.ReadWrite.Directory",
      "RoleManagementPolicy.Read.Directory",
      "RoleManagementPolicy.Read.AzureADGroup",
      "PrivilegedEligibilitySchedule.Read.AzureADGroup",
      "PrivilegedAssignmentSchedule.Read.AzureADGroup",
      "PrivilegedAssignmentSchedule.ReadWrite.AzureADGroup",
      "GroupMember.Read.All"
    ]
  },
  azureManagement: {
    hasToken: true,
    isExpired: false,
    tokenAge: 1,
    grantedScopes: ["user_impersonation"]
  }
};

describe("permission status", () => {
  test("lists every required right with a concrete feature impact", () => {
    expect(REQUIRED_PERMISSION_ITEMS.length).toBeGreaterThanOrEqual(9);
    expect(REQUIRED_PERMISSION_ITEMS.every((item) => item.missingImpact.trim().length > 0)).toBe(true);
  });

  test("marks Graph scopes and captured Azure token presence as available", () => {
    const status = buildPermissionStatus(fullTokenStatus);
    expect(getMissingPermissionItems(status)).toEqual([]);
    expect(status.find((item) => item.id === "graph.pimGroups.activate")).toMatchObject({
      isPresent: true,
      matchedBy: "PrivilegedAssignmentSchedule.ReadWrite.AzureADGroup"
    });
  });

  test("accepts higher privileged alternative scopes where Microsoft supports them", () => {
    const status = buildPermissionStatus({
      ...fullTokenStatus,
      graph: {
        ...fullTokenStatus.graph,
        grantedScopes: [
          "RoleManagement.ReadWrite.Directory",
          "PrivilegedEligibilitySchedule.ReadWrite.AzureADGroup",
          "PrivilegedAssignmentSchedule.ReadWrite.AzureADGroup",
          "PrivilegedAccess.ReadWrite.AzureADGroup",
          "Group.Read.All"
        ]
      }
    });

    expect(status.find((item) => item.id === "graph.entraRoles.read")).toMatchObject({ isPresent: true });
    expect(status.find((item) => item.id === "graph.pimGroups.read")).toMatchObject({ isPresent: true });
    expect(status.find((item) => item.id === "graph.pimGroups.policy")).toMatchObject({
      isPresent: true,
      matchedBy: "PrivilegedAccess.ReadWrite.AzureADGroup"
    });
    expect(status.find((item) => item.id === "graph.groups.resolveNames")).toMatchObject({ isPresent: true });
  });

  test("shows warning for missing permissions unless the user ignored it", () => {
    const missingStatus = buildPermissionStatus({
      ...fullTokenStatus,
      graph: {
        ...fullTokenStatus.graph,
        grantedScopes: ["RoleEligibilitySchedule.Read.Directory"]
      }
    });

    expect(shouldShowPermissionWarning(missingStatus, DEFAULT_SETTINGS)).toBe(true);
    expect(
      shouldShowPermissionWarning(missingStatus, {
        ...DEFAULT_SETTINGS,
        preferences: {
          ...DEFAULT_SETTINGS.preferences,
          permissionWarningIgnored: true
        }
      })
    ).toBe(false);
  });

  test("PowerShell guidance appends required Graph scopes without replacing existing access", () => {
    expect(permissionSetupPowerShell).toContain("$existingResourceAccess");
    expect(permissionSetupPowerShell).toContain("Update-MgApplication");
    expect(permissionSetupPowerShell).toContain("RoleAssignmentSchedule.ReadWrite.Directory");
    expect(permissionSetupPowerShell).toContain("RoleManagementPolicy.Read.AzureADGroup");
    expect(permissionSetupPowerShell).toContain("PrivilegedAssignmentSchedule.ReadWrite.AzureADGroup");
  });
});
