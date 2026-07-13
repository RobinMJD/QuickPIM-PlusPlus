import { describe, expect, test } from "vitest";
import {
  applyQuickFilters,
  getBundlePreflight,
  getRowActionState,
  getRowPolicySummary,
  type QuickFilter
} from "../src/lib/popupModel";
import type { ActivationItem, QuickPimBundle } from "../src/lib/types";

const eligibleRole: ActivationItem = {
  id: "directoryRole:reader:/",
  type: "directoryRole",
  sourceName: "Reader",
  displayName: "Reader",
  principalId: "user-1",
  roleDefinitionId: "reader",
  directoryScopeId: "/",
  scopeLabel: "Tenant",
  status: "eligible",
  activationRequirements: { justification: true, maxDurationHours: 4 }
};

const activeRole: ActivationItem = {
  ...eligibleRole,
  id: "directoryRole:admin:/",
  sourceName: "Admin",
  displayName: "Admin",
  roleDefinitionId: "admin",
  status: "active",
  activeUntil: "2026-05-18T16:00:00.000Z",
  assignmentScheduleId: "schedule-1"
};

const blockedActiveRole: ActivationItem = {
  ...activeRole,
  id: "directoryRole:blocked:/",
  assignmentScheduleId: undefined,
  assignmentScheduleInstanceId: undefined
};

const pendingRole: ActivationItem = {
  ...eligibleRole,
  id: "directoryRole:pending:/",
  displayName: "Pending Admin",
  status: "pendingApproval"
};

describe("popup action helpers", () => {
  test("explains selectable and blocked row states", () => {
    expect(getRowActionState(eligibleRole)).toMatchObject({ mode: "activate", selectable: true });
    expect(getRowActionState(activeRole)).toMatchObject({ mode: "deactivate", selectable: true });
    expect(getRowActionState(blockedActiveRole)).toMatchObject({
      mode: "deactivate",
      selectable: false,
      reason: "Microsoft did not expose the schedule identifier needed to disable this active item."
    });
    expect(getRowActionState(pendingRole)).toMatchObject({
      selectable: false,
      reason: "This request is pending approval."
    });
  });

  test("summarizes policy details for compact row details", () => {
    expect(getRowPolicySummary(eligibleRole)).toEqual([
      "Max duration: 4 hours",
      "Reason required",
      "Ticket not required",
      "Approval not required"
    ]);
  });

  test("applies quick filters after row data is assembled", () => {
    const filters: QuickFilter[] = ["favorites", "active", "highPrivilege"];
    expect(applyQuickFilters([
      { ...eligibleRole, isPrivileged: true },
      { ...activeRole, isPrivileged: true },
      { ...blockedActiveRole, isPrivileged: false }
    ], filters, new Set([activeRole.id]))).toEqual([{ ...activeRole, isPrivileged: true }]);
  });
});

describe("bundle preflight", () => {
  test("counts ready, skipped, pending, blocked, required inputs, and strictest duration", () => {
    const bundle: QuickPimBundle = {
      id: "bundle:ops",
      name: "Ops",
      itemIds: [eligibleRole.id, activeRole.id, pendingRole.id, "missing"],
      defaultDurationHours: 8
    };

    expect(getBundlePreflight(bundle, [eligibleRole, activeRole, pendingRole], "")).toMatchObject({
      readyCount: 1,
      alreadyActiveCount: 1,
      pendingApprovalCount: 1,
      missingCount: 1,
      needsJustification: true,
      isBlocked: true,
      blockedReason: "A required justification is missing.",
      strictestMaxDurationHours: 4,
      durationHours: 4
    });
  });
});
