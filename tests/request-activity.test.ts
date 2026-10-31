import { describe, expect, test } from "vitest";
import { getRequestItemProgress, requestBlocksItem, getRequestActivitySummary } from "../src/lib/requestActivity";
import { createRequestOperationItems, sanitizeRequestOperations } from "../src/lib/requestOperations";
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
    expect(getRequestActivitySummary([entry], [tracked])).toBe("1 recent request");
  });
  test("validates the nested background handoff and refuses arbitrary actions or recursive envelopes", () => {
    const request = { action: "activateItems", operationId: "request_test_1234", items: [item], durationHours: 4, justification: operation().justification, ticketInfo: operation().ticketInfo };
    expect(validateQuickPimMessage({ action: "startRequestOperation", request })).toMatchObject({ request: { action: "activateItems", durationHours: 4 } });
    expect(() => validateQuickPimMessage({ action: "startRequestOperation", request: { action: "resetExtensionData" } })).toThrow();
    expect(() => validateQuickPimMessage({ action: "startRequestOperation", request: { action: "startRequestOperation", request } })).toThrow();
    expect(() => validateQuickPimMessage({ action: "startRequestOperation", request: { ...request, durationHours: 0 } })).toThrow();
  });
});
