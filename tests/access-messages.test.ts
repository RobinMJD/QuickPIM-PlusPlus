import { describe, expect, test } from "vitest";
import { filterLoadErrorsForAccessState } from "../src/lib/accessMessages";
import type { AccessCapabilityItem } from "../src/lib/access";

const readyCapabilities: AccessCapabilityItem[] = [
  { target: "directoryRole", label: "Entra Roles", status: "ready", detail: "Last API check succeeded." },
  { target: "pimGroup", label: "PIM Groups", status: "ready", detail: "Last API check succeeded." },
  { target: "azureRole", label: "Azure Roles", status: "ready", detail: "Last API check succeeded." }
];

describe("popup access messages", () => {
  test("suppresses stale permission errors when all capability checks are ready", () => {
    const errors = filterLoadErrorsForAccessState(
      [
        '{"errorCode":"PermissionScopeNotGranted","message":"Authorization failed due to missing permission scope RoleEligibilitySchedule.Read.Directory"}',
        "Service temporarily unavailable"
      ],
      readyCapabilities
    );

    expect(errors).toEqual(["Service temporarily unavailable"]);
  });

  test("keeps permission errors when an access area is still limited", () => {
    const errors = filterLoadErrorsForAccessState(
      ["Authorization failed due to missing permission scope RoleEligibilitySchedule.Read.Directory"],
      [
        readyCapabilities[0],
        { target: "pimGroup", label: "PIM Groups", status: "limited", detail: "Blocked." },
        readyCapabilities[2]
      ]
    );

    expect(errors).toEqual(["Authorization failed due to missing permission scope RoleEligibilitySchedule.Read.Directory"]);
  });
});
