import { describe, expect, test } from "vitest";
import { getRequestItemProgress, requestBlocksItem, getRequestActivitySummary, isRequestOperationFinished, shouldShowPopupRequest } from "../src/lib/requestActivity";
import { archiveLegacyPopupResults, createRequestOperationItems, markRequestOperationResultsSeen, sanitizeRequestOperations, REQUEST_OPERATIONS_LOCAL_KEY } from "../src/lib/requestOperations";
import { validateQuickPimMessage } from "../src/lib/messages";
import type { ActivationItem, RequestOperationRecord, TrackedPimRequest } from "../src/lib/types";
const item: ActivationItem = { id: "directoryRole:role-1:/administrativeUnits/unit-a", type: "directoryRole", sourceName: "Groups Administrator", displayName: "Groups Administrator", principalId: "account-a", tenantId: "tenant-a", scopeLabel: "Restricted unit A", status: "eligible", roleDefinitionId: "role-1", directoryScopeId: "/administrativeUnits/unit-a", activationPolicyState: "ready", activationRequirements: { justification: true, ticket: true } };
function operation(): RequestOperationRecord { const now = Date.now(); return { id: "request_test_1234", action: "activate", state: "running", itemIds: [item.id], items: createRequestOperationItems([item], now), targets: ["directoryRole"], principalId: item.principalId, tenantId: item.tenantId, durationHours: 4, justification: "Resolve incident INC-1245 for the application team", ticketInfo: { ticketSystem: "ServiceNow", ticketNumber: "INC-1245" }, startedAt: now, updatedAt: now }; }
describe("durable request presentation", () => {
  test("retains names, exact scope and immutable request parameters without accepting token fields", () => {
    const entry = operation(); entry.resumePayload = { items: [{ ...item, raw: { token: "must-not-persist" }, token: "must-not-persist" } as ActivationItem], durationHours: entry.durationHours, justification: entry.justification, ticketInfo: entry.ticketInfo };
    const restored = sanitizeRequestOperations([{ ...entry, token: "must-not-persist", resumePayload: { ...entry.resumePayload, token: "must-not-persist" } }])[0];
    expect(restored).toMatchObject({ durationHours: 4, ticketInfo: entry.ticketInfo, justification: entry.justification, items: [{ itemName: item.displayName, scopeId: item.directoryScopeId }] });
    expect(JSON.stringify(restored)).not.toContain("must-not-persist");
    expect(restored.resumePayload?.items).toHaveLength(1);
    expect(sanitizeRequestOperations([{ ...entry, resumePayload: { ...entry.resumePayload, durationHours: 8 } }])[0].resumePayload).toBeUndefined();
    expect(sanitizeRequestOperations([{ ...entry, resumePayload: { ...entry.resumePayload, items: [{ ...item, principalId: "other-user" }] } }])[0].resumePayload).toBeUndefined();
  });
  test("blocks only matching account, item and scope, including an uncertain outcome", () => {
    const entry = operation();
    expect(requestBlocksItem(entry, item)).toBe(true);
    expect(requestBlocksItem(entry, { ...item, principalId: "other-account" })).toBe(false);
    expect(requestBlocksItem(entry, { ...item, tenantId: "other-tenant" })).toBe(false);
    expect(requestBlocksItem(entry, { ...item, id: "directoryRole:role-1:/" })).toBe(false);
    entry.state = "uncertain"; entry.items![0].state = "uncertain";
    expect(requestBlocksItem(entry, item)).toBe(true);
    expect(getRequestItemProgress(entry, entry.items![0], []).attention).toBe(true);
  });
  test("reflects tracked approval, active and deactivation outcomes instead of invented percentages", () => {
    const entry = operation(); entry.state = "complete"; entry.items![0].state = "terminal";
    const tracked = { operationId: entry.id, itemId: item.id, tenantId: item.tenantId, principalId: item.principalId, status: "pendingApproval" } as TrackedPimRequest;
    expect(getRequestItemProgress(entry, entry.items![0], [tracked]).label).toBe("Awaiting approval");
    expect(requestBlocksItem(entry, item, [tracked])).toBe(true);
    tracked.status = "statusUnavailable";
    expect(requestBlocksItem(entry, item, [tracked])).toBe(true);
    tracked.status = "active";
    expect(getRequestItemProgress(entry, entry.items![0], [tracked]).label).toBe("Active");
    expect(requestBlocksItem(entry, item, [tracked])).toBe(false);
    entry.action = "deactivate"; tracked.status = "completed";
    expect(getRequestItemProgress(entry, entry.items![0], [tracked]).label).toBe("Deactivated");
    expect(getRequestActivitySummary([entry], [tracked])).toBe("1 new result");
  });
  test("only acknowledged final results disappear; pending and unresolved outcomes remain visible", () => {
    const entry = operation(); entry.state = "complete"; entry.items![0].state = "terminal";
    const tracked = { operationId: entry.id, itemId: item.id, tenantId: item.tenantId, principalId: item.principalId, status: "active", activeFrom: new Date(Date.now() - 60_000).toISOString() } as TrackedPimRequest;
    expect(shouldShowPopupRequest(entry, [tracked])).toBe(true);
    entry.popupResultSeenAt = Date.now();
    expect(shouldShowPopupRequest(entry, [tracked])).toBe(false);
    expect(shouldShowPopupRequest(entry, [tracked], true)).toBe(true);
    for (const status of ["pendingApproval", "provisioning", "scheduled", "unknown", "statusUnavailable"] as const) {
      tracked.status = status;
      tracked.activeFrom = new Date(Date.now() + 60_000).toISOString();
      expect(isRequestOperationFinished(entry, [tracked])).toBe(false);
      expect(shouldShowPopupRequest(entry, [tracked])).toBe(true);
    }
    tracked.status = "failed";
    expect(isRequestOperationFinished(entry, [tracked])).toBe(true);
    expect(shouldShowPopupRequest(entry, [tracked])).toBe(false);
  });
  test("acknowledging a result preserves its journal and parameters and refuses pending work", async () => {
    const finished = operation(); finished.state = "complete"; finished.items![0].state = "terminal";
    const pending = { ...operation(), id: "request_pending_1234" };
    const now = Date.now();
    const data: Record<string, unknown> = { [REQUEST_OPERATIONS_LOCAL_KEY]: [finished, pending] };
    const storage = { get: async (key: string) => ({ [key]: data[key] }), set: async (value: Record<string, unknown>) => { Object.assign(data, value); }, remove: async (key: string) => { delete data[key]; } };
    expect(await markRequestOperationResultsSeen([finished.id, pending.id], { storage, now: now + 1, tracked: [] })).toEqual([finished.id]);
    const records = sanitizeRequestOperations(data[REQUEST_OPERATIONS_LOCAL_KEY], now + 2);
    expect(records).toHaveLength(2);
    expect(records.find((op) => op.id === finished.id)).toMatchObject({ popupResultSeenAt: now + 1, updatedAt: finished.updatedAt, justification: finished.justification, ticketInfo: finished.ticketInfo });
    expect(records.find((op) => op.id === pending.id)?.popupResultSeenAt).toBeUndefined();
    expect(sanitizeRequestOperations([{ ...finished, popupResultSeenAt: now + 10_000 }], now)[0].popupResultSeenAt).toBeUndefined();
  });
  test("upgrading the old popup archives only completed backlog, once", async () => {
    const finished = operation(); finished.state = "complete"; finished.items![0].state = "terminal";
    const pending = { ...operation(), id: "request_pending_1234" };
    const now = Date.now();
    const data: Record<string, unknown> = { [REQUEST_OPERATIONS_LOCAL_KEY]: [finished, pending] };
    const storage = { get: async (key: string) => ({ [key]: data[key] }), set: async (value: Record<string, unknown>) => { Object.assign(data, value); }, remove: async (key: string) => { delete data[key]; } };
    for (const previous of ["2.18.18", "2.19.0", "3.0.0", undefined, "invalid"]) await archiveLegacyPopupResults(previous, { storage, now: now + 1, tracked: [] });
    expect(sanitizeRequestOperations(data[REQUEST_OPERATIONS_LOCAL_KEY], now + 1).every((op) => !op.popupResultSeenAt)).toBe(true);
    await archiveLegacyPopupResults("2.18.17", { storage, now: now + 2, tracked: [] });
    const records = sanitizeRequestOperations(data[REQUEST_OPERATIONS_LOCAL_KEY], now + 3);
    expect(records.find((op) => op.id === finished.id)?.popupResultSeenAt).toBe(now + 2);
    expect(records.find((op) => op.id === pending.id)?.popupResultSeenAt).toBeUndefined();
    expect(records).toHaveLength(2);
  });
  test("validates the nested background handoff and refuses arbitrary actions or recursive envelopes", () => {
    const request = { action: "activateItems", operationId: "request_test_1234", items: [item], durationHours: 4, justification: operation().justification, ticketInfo: operation().ticketInfo };
    expect(validateQuickPimMessage({ action: "startRequestOperation", request })).toMatchObject({ request: { action: "activateItems", durationHours: 4 } });
    expect(() => validateQuickPimMessage({ action: "startRequestOperation", request: { action: "resetExtensionData" } })).toThrow();
    expect(() => validateQuickPimMessage({ action: "startRequestOperation", request: { action: "startRequestOperation", request } })).toThrow();
    expect(() => validateQuickPimMessage({ action: "startRequestOperation", request: { ...request, durationHours: 0 } })).toThrow();
  });
});
