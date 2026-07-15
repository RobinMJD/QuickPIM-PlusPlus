import { describe, expect, test } from "vitest";
import {
  applyQuickFilters,
  filterAssignedActiveItems,
  formatActivationItemStatusLabel,
  formatRemainingActivationTime,
  getActivationStatusTitle,
  getBundlePreflight,
  getRowActionState,
  getRowPolicySummary,
  getRemainingActivationTimeUpdateDelay,
  mergeEligibleWithActive,
  shouldShowRemainingActivationTime,
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

const assignedActiveRole: ActivationItem = {
  ...activeRole,
  id: "directoryRole:assigned:/",
  activeAssignmentType: "assigned",
  assignmentScheduleId: "assigned-schedule"
};

const pendingRole: ActivationItem = {
  ...eligibleRole,
  id: "directoryRole:pending:/",
  displayName: "Pending Admin",
  status: "pendingApproval"
};

describe("popup action helpers", () => {
  test("explains selectable and blocked row states", () => {
    const beforeExpiry = Date.parse("2026-05-18T12:00:00.000Z");
    expect(getRowActionState(eligibleRole, beforeExpiry)).toMatchObject({ mode: "activate", selectable: true });
    expect(getRowActionState(activeRole, beforeExpiry)).toMatchObject({ mode: "deactivate", selectable: true });
    expect(getRowActionState(activeRole, Date.parse("2026-05-18T16:00:00.000Z"))).toMatchObject({
      mode: "deactivate",
      selectable: false,
      reason: "This PIM activation has expired. Refresh roles to update its status."
    });
    expect(getRowActionState(blockedActiveRole, beforeExpiry)).toMatchObject({
      mode: "deactivate",
      selectable: false,
      reason: "Microsoft did not identify this assignment as a PIM activation, so QuickPIM++ will not try to disable it."
    });
    expect(getRowActionState(assignedActiveRole, beforeExpiry)).toMatchObject({
      mode: "deactivate",
      selectable: false,
      reason: "This role is active through an assigned access grant, not a PIM activation, so it cannot be disabled from QuickPIM++."
    });
    expect(getRowActionState(pendingRole, beforeExpiry)).toMatchObject({
      selectable: false,
      reason: "This request is pending approval."
    });
  });

  test("labels PIM activations and assigned active access differently", () => {
    expect(formatActivationItemStatusLabel({ ...activeRole, activeAssignmentType: "activated" })).toBe("PIM active");
    expect(formatActivationItemStatusLabel(assignedActiveRole)).toBe("Assigned");
    expect(getActivationStatusTitle(assignedActiveRole)).toBe(
      "Assigned access is active without a PIM activation and cannot be disabled from QuickPIM++."
    );
  });

  test("matches Microsoft role identities case-insensitively and prefers a PIM activation over assigned access", () => {
    const eligible = {
      ...eligibleRole,
      id: "directoryRole:ROLE-1:/AdministrativeUnits/AU-1",
      roleDefinitionId: "ROLE-1",
      directoryScopeId: "/AdministrativeUnits/AU-1"
    };
    const assigned = {
      ...eligible,
      id: "directoryRole:role-1:/administrativeunits/au-1",
      roleDefinitionId: "role-1",
      directoryScopeId: "/administrativeunits/au-1/",
      status: "active" as const,
      activeAssignmentType: "assigned" as const,
      assignmentScheduleId: undefined
    };
    const activated = {
      ...assigned,
      activeAssignmentType: "activated" as const,
      assignmentScheduleId: "pim-schedule-1",
      activeUntil: "2026-05-18T16:00:00.000Z"
    };

    expect(mergeEligibleWithActive([eligible], [activated, assigned], { includeActiveOnly: true })).toMatchObject([{
      id: eligible.id,
      status: "active",
      activeAssignmentType: "activated",
      assignmentScheduleId: "pim-schedule-1"
    }]);
    expect(mergeEligibleWithActive([eligible], [assigned, activated], { includeActiveOnly: true })).toHaveLength(1);

    const activeOnly = mergeEligibleWithActive([], [assigned, activated], { includeActiveOnly: true });
    expect(activeOnly).toHaveLength(1);
    expect(activeOnly[0]).toMatchObject({
      activeAssignmentType: "activated",
      assignmentScheduleId: "pim-schedule-1"
    });
  });

  test("hides assigned active roles by default without hiding PIM activations", () => {
    const pimActiveRole = { ...activeRole, activeAssignmentType: "activated" as const };
    const unknownActiveRole = { ...blockedActiveRole, activeAssignmentType: "unknown" as const };
    expect(filterAssignedActiveItems([eligibleRole, pimActiveRole, assignedActiveRole, unknownActiveRole], false)).toEqual([
      eligibleRole,
      pimActiveRole
    ]);
    expect(filterAssignedActiveItems([eligibleRole, pimActiveRole, assignedActiveRole, unknownActiveRole], true)).toEqual([
      eligibleRole,
      pimActiveRole,
      assignedActiveRole,
      unknownActiveRole
    ]);
    expect(formatActivationItemStatusLabel(activeRole)).toBe("PIM active");
  });

  test("formats and limits remaining-time counters to visible PIM activations", () => {
    const now = Date.parse("2026-05-18T12:00:00.000Z");
    expect(formatRemainingActivationTime("2026-05-18T14:05:30.000Z", now)).toBe("2h 05m");
    expect(formatRemainingActivationTime("2026-05-18T13:00:00.000Z", now)).toBe("60m 00s");
    expect(formatRemainingActivationTime("2026-05-18T12:59:05.000Z", now)).toBe("59m 05s");
    expect(formatRemainingActivationTime("2026-05-18T12:00:42.000Z", now)).toBe("0m 42s");
    expect(formatRemainingActivationTime("2026-05-18T11:59:00.000Z", now)).toBeUndefined();
    expect(formatRemainingActivationTime("invalid", now)).toBeUndefined();

    const pimActiveRole = { ...activeRole, activeAssignmentType: "activated" as const };
    expect(shouldShowRemainingActivationTime(pimActiveRole, true, now)).toBe(true);
    expect(shouldShowRemainingActivationTime(pimActiveRole, false, now)).toBe(false);
    expect(shouldShowRemainingActivationTime(assignedActiveRole, true, now)).toBe(false);
    expect(shouldShowRemainingActivationTime(eligibleRole, true, now)).toBe(false);
    expect(getRemainingActivationTimeUpdateDelay("2026-05-18T14:05:30.000Z", now)).toBe(31_020);
    expect(getRemainingActivationTimeUpdateDelay("2026-05-18T12:59:05.000Z", now)).toBe(1_020);
    expect(getRemainingActivationTimeUpdateDelay("2026-05-18T11:59:00.000Z", now)).toBeUndefined();
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
    const filters: QuickFilter[] = ["favorites", "active"];
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
