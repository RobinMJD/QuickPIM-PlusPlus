import { describe, expect, test } from "vitest";
import {
  REQUEST_TRACKING_KEY,
  REQUEST_TRACKING_MAX_DUE_PER_RUN,
  REQUEST_TRACKING_TTL_MS,
  createTrackedPimRequest,
  getActivationRequestItemStatus,
  getDueTrackedRequests,
  getEffectiveTrackedRequestStatus,
  getPendingTrackedRequestCount,
  getRequestTrackingMaintenanceTime,
  markTrackedRequestCheckFailure,
  mutateTrackedRequests,
  normalizeTrackedRequestStatus,
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
      id: "directoryRole:request-1",
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

  test("fails closed when the current token identity cannot be matched to the tracked request", () => {
    const request = createRequest({ tenantId: "tenant-1", principalId: "principal-1" });

    expect(trackedRequestMatchesTokenIdentity(request, { tenantId: "tenant-1", principalId: "principal-1" })).toBe(true);
    expect(trackedRequestMatchesTokenIdentity(request, { tenantId: "tenant-2", principalId: "principal-1" })).toBe(false);
    expect(trackedRequestMatchesTokenIdentity(request, { tenantId: "tenant-1", principalId: "principal-2" })).toBe(false);
    expect(trackedRequestMatchesTokenIdentity(request, { principalId: "principal-1" })).toBe(false);
    expect(trackedRequestMatchesTokenIdentity(request, { tenantId: "tenant-1" })).toBe(false);

    expect(trackedRequestMatchesTokenIdentity({ ...request, tenantId: undefined }, {
      principalId: "PRINCIPAL-1"
    })).toBe(true);
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

  test("serializes concurrent local mutations so submissions are not lost", async () => {
    const storage = createStorage();
    const first = createRequest({ id: "first", requestId: "first" });
    const second = createRequest({ id: "second", requestId: "second" });

    await Promise.all([
      mutateTrackedRequests((current) => upsertTrackedRequests(current, [first]), storage.area),
      mutateTrackedRequests((current) => upsertTrackedRequests(current, [second]), storage.area)
    ]);

    const saved = sanitizeTrackedRequestStore(storage.values[REQUEST_TRACKING_KEY]);
    expect(saved.requests.map((request) => request.id).sort()).toEqual(["first", "second"]);
  });
});

function createJwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.signature`;
}
