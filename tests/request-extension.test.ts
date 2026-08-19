import { describe, expect, test } from "vitest";
import {
  DEFAULT_EXTENSION_DURATION_HOURS,
  buildTrackedRequestExtensionPlan,
  formatExtensionDuration,
  getTrackedRequestExtensionSubmissionCopy,
  requireTrackedRequestExtensionRequestId,
  sanitizeExtensionDurationHours
} from "../src/lib/requestExtension";
import { createTrackedPimRequest } from "../src/lib/requestTracking";
import type { ActivationItem } from "../src/lib/types";

const NOW = Date.parse("2026-08-04T10:00:00.000Z");

const azureRole: ActivationItem = {
  id: "azureRole:reader:/subscriptions/sub-1",
  type: "azureRole",
  sourceName: "Reader",
  displayName: "Reader",
  principalId: "principal-1",
  scopeLabel: "Production",
  status: "eligible",
  roleDefinitionId: "/subscriptions/sub-1/providers/Microsoft.Authorization/roleDefinitions/reader",
  roleEligibilityScheduleId: "/subscriptions/sub-1/providers/Microsoft.Authorization/roleEligibilitySchedules/eligibility-1",
  scope: "/subscriptions/sub-1",
  activationRequirements: {
    justification: true,
    ticket: true,
    maxDurationHours: 2
  }
};

const directoryRole: ActivationItem = {
  id: "directoryRole:global-reader:/",
  type: "directoryRole",
  sourceName: "Global Reader",
  displayName: "Global Reader",
  principalId: "principal-1",
  scopeLabel: "Tenant",
  status: "eligible",
  roleDefinitionId: "global-reader",
  directoryScopeId: "/",
  activationRequirements: { justification: true, ticket: false, maxDurationHours: 4 }
};

const pimGroup: ActivationItem = {
  id: "pimGroup:group-1:member",
  type: "pimGroup",
  sourceName: "Production Admins",
  displayName: "Production Admins",
  principalId: "principal-1",
  scopeLabel: "Member",
  status: "eligible",
  groupId: "group-1",
  accessId: "member",
  activationRequirements: { justification: true, ticket: false, maxDurationHours: 2 }
};

describe("tracked PIM request extension", () => {
  test("uses a 30-minute default and accepts only supported preferences", () => {
    expect(DEFAULT_EXTENSION_DURATION_HOURS).toBe(0.5);
    expect(sanitizeExtensionDurationHours(undefined)).toBe(0.5);
    expect(sanitizeExtensionDurationHours(1)).toBe(1);
    expect(sanitizeExtensionDurationHours(2)).toBe(2);
    expect(sanitizeExtensionDurationHours(4)).toBe(4);
    expect(sanitizeExtensionDurationHours(3)).toBe(0.5);
    expect(formatExtensionDuration(0.5)).toBe("30 minutes");
    expect(formatExtensionDuration(1)).toBe("1 hour");
  });

  test("distinguishes approval-required extension submissions from scheduled continuations", () => {
    expect(getTrackedRequestExtensionSubmissionCopy(
      { itemName: "Global Reader", activationRequirements: { approval: true } },
      0.5,
      "pendingApproval"
    )).toEqual({
      title: "PIM extension awaiting approval",
      message: "Global Reader extension for 30 minutes was submitted for approval. If approved, it will start after the current activation ends.",
      requiresApproval: true
    });
    expect(getTrackedRequestExtensionSubmissionCopy(
      { itemName: "Global Reader", activationRequirements: { approval: true } },
      1,
      "scheduled"
    )).toEqual({
      title: "PIM extension scheduled",
      message: "Global Reader is scheduled for 1 hour more access after its current activation ends.",
      requiresApproval: false
    });
    expect(getTrackedRequestExtensionSubmissionCopy(
      { itemName: "Global Reader", activationRequirements: { approval: true } },
      2,
      "submitted"
    ).requiresApproval).toBe(true);
  });

  test("tracks an approval-required continuation without treating its future window as active", () => {
    const continuation = createTrackedPimRequest({
      item: { ...directoryRole, activationRequirements: { ...directoryRole.activationRequirements, approval: true } },
      action: "activate",
      requestId: "approval-extension",
      payload: { status: "PendingApproval" },
      requestedAt: "2026-08-04T10:00:00.000Z",
      scheduledStartAt: "2026-08-04T12:00:01.000Z",
      durationHours: 0.5,
      justification: "Continue production maintenance",
      continuationOfRequestId: "original-request",
      now: NOW
    });

    expect(continuation).toMatchObject({
      status: "pendingApproval",
      activeFrom: "2026-08-04T12:00:01.000Z",
      activeUntil: "2026-08-04T12:30:01.000Z",
      continuationOfRequestId: "original-request"
    });
  });

  test("does not leave an accepted extension permanently queued without a tracking id", () => {
    expect(requireTrackedRequestExtensionRequestId({
      itemId: "directoryRole:global-reader:/",
      itemName: "Global Reader",
      success: true,
      requestId: " request-123 "
    })).toBe("request-123");
    expect(() => requireTrackedRequestExtensionRequestId({
      itemId: "directoryRole:global-reader:/",
      itemName: "Global Reader",
      success: true
    })).toThrow(/did not return a tracking identifier/i);
  });

  test("queues the continuation one second after expiry and caps it to role policy", () => {
    const request = createTrackedPimRequest({
      item: azureRole,
      action: "activate",
      requestId: "request-1",
      payload: {
        properties: {
          status: "Provisioned",
          scheduleInfo: {
            startDateTime: "2026-08-04T08:00:00.000Z",
            expiration: { endDateTime: "2026-08-04T12:00:00.000Z" }
          }
        }
      },
      requestedAt: "2026-08-04T08:00:00.000Z",
      durationHours: 4,
      justification: "Complete production maintenance",
      ticketInfo: { ticketSystem: "ServiceNow", ticketNumber: "INC001" },
      now: NOW
    });
    if (!request) throw new Error("Tracked request was not created.");

    const plan = buildTrackedRequestExtensionPlan(request, 4, NOW);
    expect(plan.durationHours).toBe(2);
    expect(plan.startDateTime).toBe("2026-08-04T12:00:01.000Z");
    expect(plan.endDateTime).toBe("2026-08-04T14:00:01.000Z");
    expect(plan.ticketInfo).toEqual({ ticketSystem: "ServiceNow", ticketNumber: "INC001" });
    expect(plan.item).toMatchObject({
      status: "eligible",
      roleEligibilityScheduleId: azureRole.roleEligibilityScheduleId,
      activationRequirements: azureRole.activationRequirements
    });
  });

  test.each([
    ["Entra role", directoryRole, { roleDefinitionId: "global-reader", directoryScopeId: "/" }],
    ["PIM group", pimGroup, { groupId: "group-1", accessId: "member" }]
  ])("reconstructs an eligible %s continuation target", (_label, item, expected) => {
    const request = createTrackedPimRequest({
      item,
      action: "activate",
      requestId: `request-${item.type}`,
      payload: {
        status: "Provisioned",
        scheduleInfo: {
          startDateTime: "2026-08-04T08:00:00.000Z",
          expiration: { endDateTime: "2026-08-04T12:00:00.000Z" }
        }
      },
      requestedAt: "2026-08-04T08:00:00.000Z",
      durationHours: 4,
      justification: "Complete production maintenance",
      now: NOW
    });
    if (!request) throw new Error("Tracked request was not created.");

    const plan = buildTrackedRequestExtensionPlan(request, 1, NOW);
    expect(plan.item).toMatchObject({ type: item.type, status: "eligible", ...expected });
    expect(plan.startDateTime).toBe("2026-08-04T12:00:01.000Z");
  });

  test("blocks expired, duplicate, and incomplete ticket-required continuations", () => {
    const base = createTrackedPimRequest({
      item: azureRole,
      action: "activate",
      requestId: "request-2",
      payload: {
        properties: {
          status: "Provisioned",
          scheduleInfo: {
            startDateTime: "2026-08-04T08:00:00.000Z",
            expiration: { endDateTime: "2026-08-04T12:00:00.000Z" }
          }
        }
      },
      requestedAt: "2026-08-04T08:00:00.000Z",
      durationHours: 4,
      justification: "Complete production maintenance",
      now: NOW
    });
    if (!base) throw new Error("Tracked request was not created.");

    expect(() => buildTrackedRequestExtensionPlan(base, 0.5, NOW)).toThrow("ticket details");
    expect(() => buildTrackedRequestExtensionPlan(
      { ...base, ticketSystem: "ServiceNow", ticketNumber: "INC001", extensionAttemptState: "queued" },
      0.5,
      NOW
    )).toThrow("already queued");
    expect(() => buildTrackedRequestExtensionPlan(
      { ...base, ticketSystem: "ServiceNow", ticketNumber: "INC001", activeUntil: "2026-08-04T09:59:59.000Z" },
      0.5,
      NOW
    )).toThrow("currently active");
  });

  test("blocks continuation when the original reason is generic", () => {
    const request = createTrackedPimRequest({
      item: { ...azureRole, activationRequirements: { justification: true, ticket: false } },
      action: "activate",
      requestId: "request-generic",
      payload: {
        properties: {
          status: "Provisioned",
          scheduleInfo: {
            startDateTime: "2026-08-04T08:00:00.000Z",
            expiration: { endDateTime: "2026-08-04T12:00:00.000Z" }
          }
        }
      },
      requestedAt: "2026-08-04T08:00:00.000Z",
      durationHours: 4,
      justification: "BAU",
      now: NOW
    });
    if (!request) throw new Error("Tracked request was not created.");

    expect(() => buildTrackedRequestExtensionPlan(request, 0.5, NOW)).toThrow("cannot be reused");
  });

  test("requires the linked eligibility schedule for Azure continuations", () => {
    const request = createTrackedPimRequest({
      item: { ...azureRole, roleEligibilityScheduleId: undefined },
      action: "activate",
      requestId: "request-no-eligibility",
      payload: {
        properties: {
          status: "Provisioned",
          scheduleInfo: {
            startDateTime: "2026-08-04T08:00:00.000Z",
            expiration: { endDateTime: "2026-08-04T12:00:00.000Z" }
          }
        }
      },
      requestedAt: "2026-08-04T08:00:00.000Z",
      durationHours: 4,
      justification: "Complete production maintenance",
      ticketInfo: { ticketSystem: "ServiceNow", ticketNumber: "INC001" },
      now: NOW
    });
    if (!request) throw new Error("Tracked request was not created.");

    expect(() => buildTrackedRequestExtensionPlan(request, 0.5, NOW)).toThrow("missing identifiers");
  });
});
