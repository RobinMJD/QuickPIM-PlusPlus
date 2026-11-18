import { describe, expect, test } from "vitest";
import {
  EXPIRY_REMINDER_CATCH_UP_GRACE_MS,
  EXPIRY_REMINDER_RETRY_DELAY_MS,
  ACTIVE_ASSIGNMENT_VISIBILITY_GRACE_MS,
  REQUEST_TRACKING_KEY,
  REQUEST_TRACKING_MAX_DUE_PER_RUN,
  REQUEST_TRACKING_TTL_MS,
  createTrackedPimRequest,
  getActivationRequestItemStatus,
  getDueTrackedRequests,
  getEffectiveTrackedRequestStatus,
  getNextTrackedExpiryReminderTime,
  getPendingTrackedRequestCount,
  getRequestTrackingMaintenanceTime,
  getTrackedExpiryReminderDecision,
  getTrackedRequestActiveCacheInvalidationTargets,
  markTrackedRequestCheckFailure,
  mutateTrackedRequests,
  normalizeTrackedRequestStatus,
  reconcileTrackedExtensionSources,
  reconcileCompletedDeactivations,
  mergeRestoredTrackedRequests,
  clearTrackedRequests,
  reconcileTrackedRequestWithActiveAssignments,
  mergeTrackedRequestCheck,
  sanitizeTrackedRequestStore,
  trackedRequestMatchesValidatedToken,
  trackedRequestMatchesTokenIdentity,
  trackedRequestStatusLabel,
  updateTrackedRequestFromPayload,
  upsertTrackedRequests
} from "../src/lib/requestTracking";
import type { ActivationItem, TrackedPimRequest, TrackedPimRequestStore } from "../src/lib/types";

const NOW = Date.parse("2026-07-14T10:00:00.000Z");

const directoryRole: ActivationItem = {
  id: "directoryRole:reader:/",
  type: "directoryRole",
  sourceName: "Global Reader",
  displayName: "Global Reader",
  principalId: "principal-1",
  tenantId: "tenant-1",
  scopeLabel: "Tenant",
  status: "eligible",
  roleDefinitionId: "role-1",
  directoryScopeId: "/"
};

function createRequest(overrides: Partial<TrackedPimRequest> = {}): TrackedPimRequest {
  const request = createTrackedPimRequest({
    item: directoryRole,
    action: "activate",
    requestId: overrides.requestId || "request-1",
    payload: { status: "PendingApproval" },
    requestedAt: new Date(NOW).toISOString(),
    durationHours: 4,
    tenantId: "tenant-1",
    justification: "Review production access",
    now: NOW
  });
  if (!request) throw new Error("Test request could not be created.");
  return { ...request, ...overrides };
}

function createStorage(initial?: TrackedPimRequestStore) {
  const values: Record<string, unknown> = initial ? { [REQUEST_TRACKING_KEY]: initial } : {};
  return {
    values,
    area: {
      get: async (key: string) => ({ [key]: values[key] }),
      set: async (items: Record<string, unknown>) => {
        Object.assign(values, items);
      },
      remove: async (key: string) => {
        delete values[key];
      }
    }
  };
}

describe("tracked PIM requests", () => {
  test("confirms an approved activation from the exact new active assignment despite a stale request status", () => {
    const pending = createRequest({ status: "pendingApproval", activeUntil: new Date(NOW + 4 * 3600_000).toISOString() });
    const active: ActivationItem = { ...directoryRole, status: "active", activeAssignmentType: "activated", assignmentScheduleId: "approved-schedule",
      activeFrom: new Date(NOW + 30_000).toISOString(), activeUntil: new Date(NOW + 1830_000).toISOString() };
    const confirmed = reconcileTrackedRequestWithActiveAssignments(pending, [active], NOW + 60_000);
    expect(confirmed).toMatchObject({ status: "active", activeFrom: active.activeFrom, activeUntil: active.activeUntil,
      targetScheduleId: "approved-schedule", completedAt: new Date(NOW + 60_000).toISOString(), nextCheckAt: undefined });
    expect(reconcileTrackedRequestWithActiveAssignments(confirmed, [active], NOW + 90_000)).toBe(confirmed);
    const stale = updateTrackedRequestFromPayload(confirmed, { status: "PendingApproval" }, NOW + 90_000);
    expect(stale).toMatchObject({ status: "active", activeUntil: active.activeUntil, completedAt: confirmed.completedAt, nextCheckAt: undefined });
    expect(getEffectiveTrackedRequestStatus(updateTrackedRequestFromPayload(confirmed, { status: "PendingApproval" }, NOW + 3600_000), NOW + 3600_000)).toBe("expired");
    expect(updateTrackedRequestFromPayload(confirmed, { status: "Revoked" }, NOW + 90_000).status).toBe("completed");
    expect(mergeTrackedRequestCheck(confirmed, { ...pending, updatedAt: new Date(NOW + 90_000).toISOString() })).toBe(confirmed);
  });

  test("pending approval cannot be confirmed by an older, ambiguous, unrelated or future activation", () => {
    const pending = createRequest({ status: "pendingApproval", targetScheduleId: "approved-schedule" });
    const active: ActivationItem = { ...directoryRole, status: "active", activeAssignmentType: "activated", assignmentScheduleId: "approved-schedule",
      activeFrom: new Date(NOW + 30_000).toISOString(), activeUntil: new Date(NOW + 1830_000).toISOString() };
    for (const change of [{ tenantId: "other" }, { principalId: "other" }, { directoryScopeId: "/administrativeUnits/other" },
      { assignmentScheduleId: "old-schedule" }, { activeAssignmentType: "assigned" as const }, { activeFrom: undefined },
      { activeFrom: new Date(NOW - 30_000).toISOString() }, { activeFrom: new Date(NOW + 90_000).toISOString() },
      { activeUntil: new Date(NOW - 1).toISOString() }]) {
      expect(reconcileTrackedRequestWithActiveAssignments(pending, [{ ...active, ...change }], NOW + 60_000)).toBe(pending);
    }
    expect(reconcileTrackedRequestWithActiveAssignments(pending, [active, { ...active, assignmentScheduleInstanceId: "another-instance" }], NOW + 60_000)).toBe(pending);
    const future = { ...pending, activeFrom: new Date(NOW + 3600_000).toISOString() };
    expect(reconcileTrackedRequestWithActiveAssignments(future, [active], NOW + 60_000)).toBe(future);
    for (const status of ["denied", "failed", "canceled", "expired"] as const) {
      const terminal = { ...pending, status };
      expect(reconcileTrackedRequestWithActiveAssignments(terminal, [active], NOW + 60_000)).toBe(terminal);
    }
    const base = { principalId: "principal-1", tenantId: "tenant-1", sourceName: "Role", displayName: "Role", scopeLabel: "Scope", status: "eligible" as const };
    const otherSources: ActivationItem[] = [
      { ...base, type: "pimGroup", id: "pimGroup:group-1:member", groupId: "group-1", accessId: "member" },
      { ...base, type: "azureRole", id: "azureRole:role-1:/subscriptions/sub-1", roleDefinitionId: "role-1", scope: "/subscriptions/sub-1" }
    ];
    for (const item of otherSources) {
      const request = createTrackedPimRequest({ item, tenantId: item.tenantId, action: "activate", requestId: "approved-request", payload: { status: "PendingApproval" }, requestedAt: new Date(NOW).toISOString(), now: NOW })!;
      const assignment = { ...item, status: "active" as const, activeAssignmentType: "activated" as const, activeFrom: active.activeFrom, activeUntil: active.activeUntil };
      expect(reconcileTrackedRequestWithActiveAssignments(request, [assignment], NOW + 60_000).status).toBe("active");
      const unrelated = assignment.type === "pimGroup" ? { ...assignment, accessId: "owner" as const } : { ...assignment, scope: "/subscriptions/other" };
      expect(reconcileTrackedRequestWithActiveAssignments(request, [unrelated], NOW + 60_000)).toBe(request);
    }
  });

  test("clearing or restoring history preserves local in-progress tracking", async () => {
    const timestamps = { requestedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    const pending = createRequest({ status: "pendingApproval", nextCheckAt: new Date(Date.now() + 30_000).toISOString(), ...timestamps });
    const active = createRequest({ requestId: "still-active", status: "active", activeUntil: new Date(Date.now() + 3600_000).toISOString(), ...timestamps });
    const done = createRequest({ requestId: "finished", action: "deactivate", status: "completed", rawStatus: "Revoked", ...timestamps });
    const storage = createStorage({ version: 1, requests: [pending, active, done] });
    const cleared = await clearTrackedRequests(storage.area);
    expect(cleared.requests).toHaveLength(2);
    expect(cleared.requests).toEqual(expect.arrayContaining([pending, expect.objectContaining({ id: active.id, status: "active" })]));
    const restored = mergeRestoredTrackedRequests({ version: 1, requests: [pending] }, { version: 1, requests: [{ ...pending, status: "failed" }, done] });
    expect(restored.requests.find((request) => request.id === pending.id)?.status).toBe("pendingApproval");
    expect(restored.requests.find((request) => request.id === done.id)?.status).toBe("completed");
  });
  test("completed disables reconcile only the same original tenant, account and schedule", () => {
    const activation = createRequest({ status: "active", targetScheduleId: "schedule-original", activeUntil: new Date(NOW + 3600_000).toISOString() });
    const disabled = createRequest({ id: "disable", requestId: "disable", action: "deactivate", status: "completed",
      targetScheduleId: "schedule-original", completedAt: new Date(NOW).toISOString() });
    expect(reconcileCompletedDeactivations({ version: 1, requests: [activation, disabled] }, NOW).requests[0].status).toBe("completed");
    for (const update of [
      { targetScheduleId: "replacement" }, { tenantId: "other" }, { principalId: "other" }, { status: "submitted" as const },
      { itemId: "directoryRole:role-1:/administrativeUnits/another-unit" },
      { requestedAt: new Date(NOW - 60_000).toISOString() }
    ]) {
      const store = { version: 1 as const, requests: [activation, { ...disabled, ...update }] };
      expect(reconcileCompletedDeactivations(store, NOW)).toBe(store);
    }
  });
  test("creates a bounded local record from a Microsoft request response", () => {
    const request = createTrackedPimRequest({
      item: directoryRole,
      action: "activate",
      requestId: "request-1",
      payload: {
        id: "request-1",
        status: "PendingApproval",
        scheduleInfo: {
          expiration: { type: "AfterDuration", duration: "PT4H" }
        }
      },
      requestedAt: new Date(NOW).toISOString(),
      durationHours: 4,
      justification: "Review production access",
      bundleName: "Daily operations",
      tenantId: "tenant-1",
      now: NOW
    });

    expect(request).toMatchObject({
      id: "tenant:tenant-1:directoryRole:9892023467d422c8",
      status: "pendingApproval",
      rawStatus: "PendingApproval",
      itemName: "Global Reader",
      roleDefinitionId: "role-1",
      durationHours: 4,
      bundleName: "Daily operations",
      tenantId: "tenant-1"
    });
    expect(request?.nextCheckAt).toBe("2026-07-14T10:00:30.000Z");
  });

  test("invalidates active-role cache when tracked request lifecycle changes", () => {
    const scheduled = createRequest({
      id: "scheduled-extension",
      requestId: "scheduled-extension",
      status: "scheduled",
      activeFrom: "2026-07-14T13:00:01.000Z",
      activeUntil: "2026-07-14T13:30:01.000Z"
    });
    const active = { ...scheduled, status: "active" as const };
    const expired = { ...active, status: "expired" as const };

    expect(getTrackedRequestActiveCacheInvalidationTargets(
      { version: 1, requests: [scheduled] },
      { version: 1, requests: [active] }
    )).toEqual(["directoryRole"]);
    expect(getTrackedRequestActiveCacheInvalidationTargets(
      { version: 1, requests: [active] },
      { version: 1, requests: [expired] }
    )).toEqual(["directoryRole"]);
    expect(getTrackedRequestActiveCacheInvalidationTargets(
      { version: 1, requests: [active] },
      { version: 1, requests: [active] }
    )).toEqual([]);
  });

  test("normalizes Microsoft lifecycle states and derives expiry", () => {
    expect(normalizeTrackedRequestStatus("PendingAdminDecision", "activate")).toBe("pendingApproval");
    expect(normalizeTrackedRequestStatus("PendingProvisioning", "activate")).toBe("provisioning");
    expect(normalizeTrackedRequestStatus("Provisioned", "activate")).toBe("active");
    expect(normalizeTrackedRequestStatus("Provisioned", "deactivate")).toBe("completed");
    expect(normalizeTrackedRequestStatus("AdminDenied", "activate")).toBe("denied");
    expect(normalizeTrackedRequestStatus("Revoked", "deactivate")).toBe("completed");
    expect(getActivationRequestItemStatus("PendingProvisioning")).toBe("pendingApproval");
    expect(getActivationRequestItemStatus("Accepted")).toBe("pendingApproval");
    expect(getActivationRequestItemStatus("ScheduleCreated")).toBe("pendingApproval");
    expect(getActivationRequestItemStatus("Provisioned")).toBe("active");
    expect(getActivationRequestItemStatus("AdminDenied")).toBeUndefined();
    expect(getActivationRequestItemStatus(undefined)).toBeUndefined();
    expect(trackedRequestStatusLabel("statusUnavailable")).toBe("Status unavailable");

    const active = createRequest({ status: "active", activeUntil: new Date(NOW - 1).toISOString() });
    expect(getEffectiveTrackedRequestStatus(active, NOW)).toBe("expired");
  });

  test("updates successful checks and stops unavailable tracking after the bounded window", () => {
    const pending = createRequest();
    const active = updateTrackedRequestFromPayload(
      pending,
      {
        status: "Provisioned",
        scheduleInfo: { expiration: { endDateTime: "2026-07-14T14:00:00.000Z" } }
      },
      NOW + 30_000
    );
    expect(active).toMatchObject({ status: "active", activeUntil: "2026-07-14T14:00:00.000Z", checkCount: 1 });
    expect(active.nextCheckAt).toBeUndefined();
    const invalidSchedule = updateTrackedRequestFromPayload(pending, {
      status: "Provisioned", scheduleInfo: { expiration: { duration: "P999999999999999D" } }
    }, NOW + 30_000);
    expect(invalidSchedule.status).toBe("active");
    expect(invalidSchedule.activeUntil).toBeUndefined();

    const unavailable = markTrackedRequestCheckFailure(
      pending,
      "Microsoft has not exposed this request status yet.",
      NOW + REQUEST_TRACKING_TTL_MS
    );
    expect(unavailable.status).toBe("statusUnavailable");
    expect(unavailable.nextCheckAt).toBeUndefined();
  });

  test("selects only due unresolved requests and caps background work", () => {
    const requests = Array.from({ length: REQUEST_TRACKING_MAX_DUE_PER_RUN + 5 }, (_, index) => createRequest({
      id: `directoryRole:request-${index}`,
      requestId: `request-${index}`,
      nextCheckAt: new Date(NOW - 1).toISOString()
    }));
    requests.push(createRequest({ id: "finished", requestId: "finished", status: "completed", nextCheckAt: undefined }));
    const store: TrackedPimRequestStore = { version: 1, requests };

    expect(getDueTrackedRequests(store, NOW)).toHaveLength(REQUEST_TRACKING_MAX_DUE_PER_RUN);
    expect(getPendingTrackedRequestCount(store)).toBe(REQUEST_TRACKING_MAX_DUE_PER_RUN + 5);
    expect(getDueTrackedRequests(store, NOW, ["finished"])).toHaveLength(1);
  });

  test("schedules the next poll or optional expiry reminder without a recurring idle alarm", () => {
    const pending = createRequest({ nextCheckAt: new Date(NOW + 60_000).toISOString() });
    const active = createRequest({
      id: "active",
      requestId: "active",
      status: "active",
      nextCheckAt: undefined,
      activeUntil: new Date(NOW + 60 * 60_000).toISOString()
    });
    const store = { version: 1, requests: [pending, active] } as TrackedPimRequestStore;

    expect(getRequestTrackingMaintenanceTime(store, { notificationsEnabled: false, expiryReminderMinutes: 15, now: NOW })).toBe(NOW + 60_000);
    expect(getRequestTrackingMaintenanceTime(
      { version: 1, requests: [active] },
      { notificationsEnabled: true, expiryReminderMinutes: 15, now: NOW }
    )).toBe(NOW + 45 * 60_000);
    expect(getRequestTrackingMaintenanceTime(
      { version: 1, requests: [{ ...active, status: "completed", activeUntil: undefined }] },
      { notificationsEnabled: false, expiryReminderMinutes: 15, now: NOW }
    )).toBeUndefined();
  });

  test("catches up a recently missed expiry reminder after browser downtime", () => {
    const activeUntil = NOW - 10 * 60_000;
    const expired = createRequest({
      id: "expired",
      requestId: "expired",
      status: "expired",
      nextCheckAt: undefined,
      activeUntil: new Date(activeUntil).toISOString()
    });
    const store = { version: 1, requests: [expired] } as TrackedPimRequestStore;

    expect(getTrackedExpiryReminderDecision(expired, 5, NOW)).toBe("missed");
    expect(getNextTrackedExpiryReminderTime(store, 5, NOW)).toBe(NOW + 1_000);
    expect(getRequestTrackingMaintenanceTime(
      store,
      { notificationsEnabled: true, expiryReminderMinutes: 5, now: NOW }
    )).toBe(NOW + 1_000);
    expect(getTrackedExpiryReminderDecision(
      { ...expired, activeUntil: new Date(NOW - EXPIRY_REMINDER_CATCH_UP_GRACE_MS - 1).toISOString() },
      5,
      NOW
    )).toBeUndefined();
    const denied = { ...expired, id: "denied", requestId: "denied", status: "denied" as const };
    expect(getTrackedExpiryReminderDecision(denied, 5, NOW)).toBeUndefined();
    expect(getNextTrackedExpiryReminderTime({ version: 1, requests: [denied] }, 5, NOW)).toBeUndefined();
  });

  test("backs off a failed reminder instead of retrying every second", () => {
    const attemptedAt = NOW - 60_000;
    const active = createRequest({
      id: "active-retry",
      requestId: "active-retry",
      status: "active",
      nextCheckAt: undefined,
      activeUntil: new Date(NOW + 10 * 60_000).toISOString(),
      expiryReminderAttemptedAt: new Date(attemptedAt).toISOString()
    });
    const store = { version: 1, requests: [active] } as TrackedPimRequestStore;

    expect(getTrackedExpiryReminderDecision(active, 15, NOW)).toBeUndefined();
    expect(getNextTrackedExpiryReminderTime(store, 15, NOW)).toBe(attemptedAt + EXPIRY_REMINDER_RETRY_DELAY_MS);
    expect(getTrackedExpiryReminderDecision(
      active,
      15,
      attemptedAt + EXPIRY_REMINDER_RETRY_DELAY_MS
    )).toBe("upcoming");
  });

  test("fails closed when the current token identity cannot be matched to the tracked request", () => {
    const request = createRequest({ tenantId: "tenant-1", principalId: "principal-1" });

    expect(trackedRequestMatchesTokenIdentity(request, { tenantId: "tenant-1", principalId: "principal-1" })).toBe(true);
    expect(trackedRequestMatchesTokenIdentity(request, { tenantId: "tenant-2", principalId: "principal-1" })).toBe(false);
    expect(trackedRequestMatchesTokenIdentity(request, { tenantId: "tenant-1", principalId: "principal-2" })).toBe(false);
    expect(trackedRequestMatchesTokenIdentity(request, { principalId: "principal-1" })).toBe(false);
    expect(trackedRequestMatchesTokenIdentity(request, { tenantId: "tenant-1" })).toBe(false);

    expect(trackedRequestMatchesTokenIdentity({ ...request, tenantId: undefined }, {
      principalId: "PRINCIPAL-1"
    })).toBe(false);
  });

  test("does not consume tracking checks with expired or wrong-audience portal tokens", () => {
    const request = createRequest({ tenantId: "tenant-1", principalId: "principal-1" });
    const validGraphToken = createJwt({
      aud: "https://graph.microsoft.com",
      tid: "tenant-1",
      oid: "principal-1",
      exp: Math.floor((NOW + 60_000) / 1000)
    });
    const expiredGraphToken = createJwt({
      aud: "https://graph.microsoft.com",
      tid: "tenant-1",
      oid: "principal-1",
      exp: Math.floor((NOW - 1) / 1000)
    });
    const wrongAudienceToken = createJwt({
      aud: "https://management.azure.com/",
      tid: "tenant-1",
      oid: "principal-1",
      exp: Math.floor((NOW + 60_000) / 1000)
    });

    expect(trackedRequestMatchesValidatedToken(request, validGraphToken, NOW)).toBe(true);
    expect(trackedRequestMatchesValidatedToken(request, expiredGraphToken, NOW)).toBe(false);
    expect(trackedRequestMatchesValidatedToken(request, wrongAudienceToken, NOW)).toBe(false);
  });

  test("derives activation expiry from Microsoft's effective schedule start after approval", () => {
    const pending = createRequest({ requestedAt: "2026-07-14T10:00:00.000Z", durationHours: 4 });
    const active = updateTrackedRequestFromPayload(
      pending,
      {
        status: "Provisioned",
        scheduleInfo: {
          startDateTime: "2026-07-14T12:00:00.000Z",
          expiration: { duration: "PT4H" }
        }
      },
      Date.parse("2026-07-14T12:01:00.000Z")
    );

    expect(active.activeUntil).toBe("2026-07-14T16:00:00.000Z");
  });

  test("reconciles active requests without an end time against active assignments", () => {
    const activeWithoutEnd = createRequest({
      status: "active",
      rawStatus: "Provisioned",
      activeUntil: undefined,
      nextCheckAt: new Date(NOW).toISOString()
    });
    const matchingActive: ActivationItem = {
      ...directoryRole,
      status: "active",
      activeAssignmentType: "activated",
      activeUntil: "2026-07-14T14:00:00.000Z"
    };

    expect(reconcileTrackedRequestWithActiveAssignments(activeWithoutEnd, [matchingActive], NOW)).toMatchObject({
      status: "active",
      activeUntil: "2026-07-14T14:00:00.000Z",
      nextCheckAt: undefined,
      lastError: undefined
    });

    const assignedOnly = { ...matchingActive, activeAssignmentType: "assigned" as const };
    expect(reconcileTrackedRequestWithActiveAssignments(activeWithoutEnd, [], NOW, false)).toBe(activeWithoutEnd);
    const waiting = reconcileTrackedRequestWithActiveAssignments(activeWithoutEnd, [assignedOnly], NOW);
    expect(waiting).toMatchObject({
      status: "active",
      activeAssignmentMissingSince: "2026-07-14T10:00:00.000Z",
      lastError: "Waiting for the active assignment to become visible."
    });

    const expired = reconcileTrackedRequestWithActiveAssignments(
      waiting,
      [],
      NOW + ACTIVE_ASSIGNMENT_VISIBILITY_GRACE_MS
    );
    expect(expired).toMatchObject({ status: "expired", nextCheckAt: undefined });
    expect(expired.activeAssignmentMissingSince).toBeUndefined();
  });

  test("resolves an administrative-unit request only from an active assignment at the same scope", () => {
    const scopedRole: ActivationItem = {
      ...directoryRole,
      id: "directoryRole:role-1:/administrativeUnits/au-1",
      directoryScopeId: "/administrativeUnits/au-1",
      scopeLabel: "Restricted AU 1"
    };
    const request = createTrackedPimRequest({
      item: scopedRole,
      action: "activate",
      requestId: "au-request",
      payload: { status: "Provisioned" },
      requestedAt: new Date(NOW).toISOString(),
      durationHours: 2,
      tenantId: "tenant-1",
      justification: "Maintain restricted administrative-unit groups",
      now: NOW
    });
    if (!request) throw new Error("Scoped test request could not be created.");
    const tenantActive: ActivationItem = {
      ...directoryRole,
      status: "active",
      activeAssignmentType: "activated",
      activeUntil: "2026-07-14T14:00:00.000Z"
    };
    const otherAuActive: ActivationItem = {
      ...tenantActive,
      id: "directoryRole:role-1:/administrativeUnits/au-2",
      directoryScopeId: "/administrativeUnits/au-2",
      activeUntil: "2026-07-14T13:00:00.000Z"
    };

    const waiting = reconcileTrackedRequestWithActiveAssignments(request, [tenantActive, otherAuActive], NOW);
    expect(waiting.activeUntil).toBeUndefined();
    expect(waiting).toMatchObject({
      directoryScopeId: scopedRole.directoryScopeId,
      activeAssignmentMissingSince: "2026-07-14T10:00:00.000Z",
      lastError: "Waiting for the active assignment to become visible."
    });

    const matchingAuActive: ActivationItem = {
      ...otherAuActive,
      id: scopedRole.id,
      directoryScopeId: "/AdministrativeUnits/AU-1/",
      activeUntil: "2026-07-14T12:00:00.000Z"
    };
    const resolved = reconcileTrackedRequestWithActiveAssignments(
      waiting,
      [tenantActive, otherAuActive, matchingAuActive],
      NOW + 30_000
    );
    expect(resolved).toMatchObject({ status: "active", activeUntil: matchingAuActive.activeUntil });
    expect(resolved.lastError).toBeUndefined();
    expect(resolved.activeAssignmentMissingSince).toBeUndefined();
    expect(resolved.nextCheckAt).toBeUndefined();
  });

  test("keeps a future accepted continuation scheduled until its exact start", () => {
    const scheduled = createTrackedPimRequest({
      item: directoryRole,
      action: "activate",
      requestId: "future-request",
      payload: { status: "Provisioned" },
      requestedAt: "2026-07-14T10:00:00.000Z",
      scheduledStartAt: "2026-07-14T12:00:01.000Z",
      durationHours: 1,
      justification: "Continue production maintenance",
      continuationOfRequestId: "request-1",
      now: NOW
    });
    if (!scheduled) throw new Error("Scheduled request could not be created.");

    expect(scheduled).toMatchObject({
      status: "scheduled",
      activeFrom: "2026-07-14T12:00:01.000Z",
      activeUntil: "2026-07-14T13:00:01.000Z",
      continuationOfRequestId: "request-1"
    });
    expect(getEffectiveTrackedRequestStatus(scheduled, Date.parse("2026-07-14T12:00:00.000Z"))).toBe("scheduled");
    expect(getEffectiveTrackedRequestStatus(scheduled, Date.parse("2026-07-14T12:00:01.000Z"))).toBe("active");
    expect(getRequestTrackingMaintenanceTime(
      { version: 1, requests: [scheduled] },
      { notificationsEnabled: false, expiryReminderMinutes: 15, now: NOW }
    )).toBe(Date.parse("2026-07-14T12:00:01.000Z"));
    expect(trackedRequestStatusLabel("scheduled")).toBe("Scheduled");
  });

  test("allows a new continuation after the previous one is denied", () => {
    const source = createRequest({
      status: "active",
      activeUntil: "2026-07-14T14:00:00.000Z",
      extensionAttemptState: "queued",
      extensionRequestId: "extension-1"
    });
    const continuation = createRequest({
      id: "directoryRole:extension-1",
      requestId: "extension-1",
      status: "denied",
      continuationOfRequestId: source.requestId
    });

    const reconciled = reconcileTrackedExtensionSources(
      { version: 1, requests: [
        source,
        { ...continuation, tenantId: "other-tenant", id: "unrelated-denial", status: "denied" },
        continuation
      ] },
      NOW
    );
    expect(reconciled.requests[0]).toMatchObject({
      extensionAttemptState: undefined,
      extensionRequestId: undefined,
      extensionLastError: "The previous extension request was not completed."
    });
  });

  test("keeps the source extension locked while its continuation awaits approval", () => {
    const source = createRequest({
      status: "active",
      activeUntil: "2026-07-14T14:00:00.000Z",
      extensionAttemptState: "queued",
      extensionRequestId: "extension-pending"
    });
    const continuation = createRequest({
      id: "directoryRole:extension-pending",
      requestId: "extension-pending",
      status: "pendingApproval",
      continuationOfRequestId: source.requestId
    });

    const olderDenial = createRequest({
      requestId: "extension-denied", continuationOfRequestId: source.requestId, status: "denied"
    });
    const otherTenantDenial = { ...continuation, id: "unrelated-denial", tenantId: "other-tenant", status: "denied" as const };
    const store = { version: 1 as const, requests: [source, olderDenial, otherTenantDenial, continuation] };
    expect(reconcileTrackedExtensionSources(store, NOW)).toBe(store);
  });

  test("releases an orphaned extension lock after Microsoft visibility grace expires", () => {
    const source = createRequest({
      status: "active",
      activeUntil: "2026-07-14T14:00:00.000Z",
      extensionAttemptState: "queued",
      extensionRequestId: "missing-extension",
      extensionRequestedAt: new Date(NOW - ACTIVE_ASSIGNMENT_VISIBILITY_GRACE_MS - 1).toISOString()
    });

    const reconciled = reconcileTrackedExtensionSources(
      { version: 1, requests: [source] },
      NOW
    );
    expect(reconciled.requests[0]).toMatchObject({
      extensionAttemptState: undefined,
      extensionRequestId: undefined,
      extensionLastError: "The previous extension request was not completed."
    });
  });

  test("sanitizes imported records, redacts token-like errors, and caps the store", () => {
    const unsafe = createRequest({
      lastError: `Bearer aaa.${"b".repeat(400)}.ccc should never be retained`,
      justification: "x".repeat(2_000)
    });
    const store = sanitizeTrackedRequestStore({
      version: 99,
      requests: Array.from({ length: 120 }, (_, index) => ({
        ...unsafe,
        id: `directoryRole:request-${index}`,
        requestId: `request-${index}`
      }))
    });

    expect(store.version).toBe(1);
    expect(store.requests).toHaveLength(100);
    expect(store.requests[0].lastError).toContain("[redacted token]");
    expect(store.requests[0].lastError).not.toContain("aaa.");
    expect(store.requests[0].justification).toHaveLength(1024);
  });

  test("sorts every bounded-storage candidate before retaining the newest requests", () => {
    const oldRequests = Array.from({ length: 1_001 }, (_, index) => createRequest({
      id: `old-${index}`,
      requestId: `old-${index}`,
      requestedAt: new Date(NOW - 2 * 60 * 60_000 - index).toISOString(),
      updatedAt: new Date(NOW - 2 * 60 * 60_000 - index).toISOString()
    }));
    const newest = createRequest({
      id: "newest-after-input-cap",
      requestId: "newest-after-input-cap",
      requestedAt: new Date(NOW - 1_000).toISOString(),
      updatedAt: new Date(NOW - 1_000).toISOString()
    });

    const store = sanitizeTrackedRequestStore({ version: 1, requests: [...oldRequests, newest] }, NOW);

    expect(store.requests).toHaveLength(100);
    expect(store.requests[0].requestId).toBe(newest.requestId);
    expect(store.requests.some((request) => request.requestId === newest.requestId)).toBe(true);
  });

  test("rejects impossible request chronology and repairs stalled future checks", () => {
    const valid = createRequest();
    const delayed = createRequest({
      id: "delayed",
      requestId: "delayed",
      nextCheckAt: new Date(NOW + 60 * 60_000).toISOString()
    });
    const future = createRequest({
      id: "future",
      requestId: "future",
      requestedAt: new Date(NOW + 6 * 60_000).toISOString(),
      updatedAt: new Date(NOW + 6 * 60_000).toISOString()
    });
    const reversed = createRequest({
      id: "reversed",
      requestId: "reversed",
      updatedAt: new Date(NOW - 1).toISOString()
    });
    const stalled = createRequest({
      id: "stalled",
      requestId: "stalled",
      nextCheckAt: "2099-01-01T00:00:00.000Z",
      lastCheckedAt: "2099-01-01T00:00:00.000Z"
    });

    const store = sanitizeTrackedRequestStore({ version: 1, requests: [valid, delayed, future, reversed, stalled] }, NOW);

    expect(store.requests.map((request) => request.requestId).sort()).toEqual([
      valid.requestId,
      "delayed",
      "stalled"
    ].sort());
    expect(store.requests.find((request) => request.requestId === "delayed")?.nextCheckAt).toBe("2026-07-14T11:00:00.000Z");
    expect(store.requests.find((request) => request.requestId === "stalled")).toMatchObject({
      nextCheckAt: undefined,
      lastCheckedAt: undefined
    });
    expect(getDueTrackedRequests(store, NOW).map((request) => request.requestId)).toContain("stalled");
  });

  test("serializes concurrent local mutations so submissions are not lost", async () => {
    const storage = createStorage();
    const first = createRequest({ id: "first", requestId: "first" });
    const second = createRequest({ id: "second", requestId: "second" });

    await Promise.all([
      mutateTrackedRequests((current) => upsertTrackedRequests(current, [first]), storage.area),
      mutateTrackedRequests((current) => upsertTrackedRequests(current, [second]), storage.area)
    ]);

    const saved = sanitizeTrackedRequestStore(storage.values[REQUEST_TRACKING_KEY]);
    expect(saved.requests.map((request) => request.requestId).sort()).toEqual(["first", "second"]);
  });
});

function createJwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.signature`;
}
