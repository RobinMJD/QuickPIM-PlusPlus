import { describe, expect, test, vi } from "vitest";
import {
  REQUEST_OPERATIONS_SESSION_KEY,
  REQUEST_OPERATION_RECONCILIATION_GRACE_MS,
  REQUEST_OPERATION_TTL_MS,
  beginRequestOperation,
  completeRequestOperation,
  dismissRequestOperations,
  failRequestOperation,
  getRequestOperationFingerprint,
  loadRequestOperations,
  selectNextRequestOperation,
  sanitizeRequestOperations,
  trackedRequestMatchesOperation,
  touchRequestOperation
} from "../src/lib/requestOperations";

const NOW = Date.parse("2026-07-22T10:00:00.000Z");

describe("background request operation journal", () => {
  test("correlates recovered Microsoft requests by operation id and bounds legacy matches", () => {
    const operation = {
      id: "request_operation_recovery",
      action: "activate" as const,
      itemIds: ["pimGroup:group-1:member"],
      targets: ["pimGroup" as const],
      tenantId: "tenant-1",
      principalId: "principal-1",
      state: "running" as const,
      startedAt: NOW,
      updatedAt: NOW + 60_000,
      durationHours: 2,
      justification: "Approved change",
      ticketInfo: { ticketSystem: "ServiceNow", ticketNumber: "CHG-123" }
    };
    const request = {
      id: "pimGroup:microsoft-request",
      requestId: "microsoft-request",
      operationId: operation.id,
      action: "activate" as const,
      itemId: "pimGroup:group-1:member",
      itemName: "Group 1",
      itemType: "pimGroup" as const,
      tenantId: "tenant-1",
      principalId: "principal-1",
      status: "submitted" as const,
      requestedAt: new Date(NOW + 10_000).toISOString(),
      updatedAt: new Date(NOW + 10_000).toISOString(),
      durationHours: 2,
      justification: "Approved change",
      ticketSystem: "ServiceNow",
      ticketNumber: "CHG-123",
      checkCount: 0
    };

    expect(trackedRequestMatchesOperation(request, operation)).toBe(true);
    expect(trackedRequestMatchesOperation({ ...request, operationId: "another_operation" }, operation)).toBe(false);
    expect(trackedRequestMatchesOperation({
      ...request,
      operationId: undefined,
      requestedAt: new Date(operation.updatedAt + REQUEST_OPERATION_RECONCILIATION_GRACE_MS + 1).toISOString()
    }, operation)).toBe(false);
    expect(trackedRequestMatchesOperation({
      ...request,
      operationId: undefined,
      ticketNumber: "CHG-999"
    }, operation)).toBe(false);
  });

  test("matches safe retries but distinguishes reused IDs with different work", () => {
    const original = {
      id: "request_operation_identity",
      action: "activate" as const,
      itemIds: ["pimGroup:group-2:member", "pimGroup:group-1:member"],
      targets: ["pimGroup" as const],
      durationHours: 2,
      justification: "Approved change"
    };
    expect(getRequestOperationFingerprint({
      ...original,
      itemIds: [...original.itemIds].reverse()
    })).toBe(getRequestOperationFingerprint(original));
    expect(getRequestOperationFingerprint({
      ...original,
      action: "deactivate"
    })).not.toBe(getRequestOperationFingerprint(original));
    expect(getRequestOperationFingerprint({
      ...original,
      sourceInstallationId: "installation-a"
    })).not.toBe(getRequestOperationFingerprint({
      ...original,
      sourceInstallationId: "installation-b"
    }));
    expect(getRequestOperationFingerprint({
      ...original,
      itemIds: ["pimGroup:another-group:member"]
    })).not.toBe(getRequestOperationFingerprint(original));
    expect(getRequestOperationFingerprint({
      ...original,
      ticketInfo: { ticketSystem: "ServiceNow", ticketNumber: "INC-123" }
    })).not.toBe(getRequestOperationFingerprint(original));
    expect(getRequestOperationFingerprint({ ...original, ticketInfo: {} })).toBe(
      getRequestOperationFingerprint(original)
    );
    expect(getRequestOperationFingerprint({
      ...original,
      itemIds: original.itemIds.map((itemId) => itemId.toUpperCase())
    })).toBe(getRequestOperationFingerprint(original));
  });

  test("does not let a late heartbeat revert a completed operation", async () => {
    const data: Record<string, unknown> = {};
    const storage = makeStorage(data);
    await beginRequestOperation({
      id: "request_operation_heartbeat",
      action: "activate",
      itemIds: ["directoryRole:reader:/"],
      targets: ["directoryRole"],
      startedAt: NOW
    }, { storage, now: NOW });
    await completeRequestOperation("request_operation_heartbeat", {
      success: true,
      results: [{ itemId: "directoryRole:reader:/", itemName: "Reader", success: true }],
      errors: []
    }, { storage, now: NOW + 1_000 });

    await touchRequestOperation("request_operation_heartbeat", { storage, now: NOW + 2_000 });

    expect(await loadRequestOperations({ storage, now: NOW + 2_000 })).toEqual([
      expect.objectContaining({ state: "complete", updatedAt: NOW + 1_000 })
    ]);
  });

  test("drains the oldest terminal result before unresolved or newer terminal operations", () => {
    const operations = sanitizeRequestOperations([
      {
        id: "request_operation_running",
        action: "activate",
        itemIds: ["directoryRole:reader:/"],
        targets: ["directoryRole"],
        state: "running",
        startedAt: NOW - 30_000,
        updatedAt: NOW - 10_000
      },
      {
        id: "request_operation_new_terminal",
        action: "activate",
        itemIds: ["directoryRole:writer:/"],
        targets: ["directoryRole"],
        state: "complete",
        startedAt: NOW - 20_000,
        updatedAt: NOW - 2_000,
        terminalAt: NOW - 2_000,
        response: {
          success: true,
          results: [{ itemId: "directoryRole:writer:/", itemName: "Writer", success: true }],
          errors: []
        }
      },
      {
        id: "request_operation_old_terminal",
        action: "activate",
        itemIds: ["directoryRole:admin:/"],
        targets: ["directoryRole"],
        state: "error",
        startedAt: NOW - 40_000,
        updatedAt: NOW - 5_000,
        terminalAt: NOW - 5_000,
        error: "Stopped"
      }
    ], NOW);

    expect(selectNextRequestOperation(operations)?.id).toBe("request_operation_old_terminal");
    expect(selectNextRequestOperation(
      operations,
      new Set(["request_operation_old_terminal", "request_operation_new_terminal"])
    )?.id).toBe("request_operation_running");
  });

  test("persists a running request and its completed response until the popup acknowledges it", async () => {
    const data: Record<string, unknown> = {};
    const storage = makeStorage(data);

    await beginRequestOperation({
      id: "request_operation_1",
      action: "activate",
      itemIds: ["pimGroup:group-1:member"],
      targets: ["pimGroup"],
      startedAt: NOW,
      durationHours: 2,
      justification: "Apply the approved Intune change"
    }, { storage, now: NOW });

    expect(await loadRequestOperations({ storage, now: NOW })).toEqual([
      expect.objectContaining({
        id: "request_operation_1",
        state: "running",
        durationHours: 2,
        justification: "Apply the approved Intune change"
      })
    ]);

    await completeRequestOperation("request_operation_1", {
      success: true,
      results: [{ itemId: "pimGroup:group-1:member", itemName: "Intune operators", success: true }],
      errors: []
    }, { storage, now: NOW + 1_000 });

    expect(await loadRequestOperations({ storage, now: NOW + 1_000 })).toEqual([
      expect.objectContaining({
        state: "complete",
        response: expect.objectContaining({ success: true })
      })
    ]);

    await dismissRequestOperations(["request_operation_1"], { storage, now: NOW + 2_000 });
    expect(await loadRequestOperations({ storage, now: NOW + 2_000 })).toEqual([]);
    expect(data).not.toHaveProperty(REQUEST_OPERATIONS_SESSION_KEY);
  });

  test("keeps a sanitized failure for popup recovery and removes expired journal entries", async () => {
    const data: Record<string, unknown> = {};
    const storage = makeStorage(data);

    await beginRequestOperation({
      id: "request_operation_2",
      action: "deactivate",
      itemIds: ["directoryRole:reader:/"],
      targets: ["directoryRole"],
      startedAt: NOW
    }, { storage, now: NOW });
    await failRequestOperation("request_operation_2", "x".repeat(2_000), { storage, now: NOW + 1_000 });

    const failed = await loadRequestOperations({ storage, now: NOW + 1_000 });
    expect(failed[0]).toMatchObject({ state: "error" });
    expect(failed[0].error).toHaveLength(1_000);

    expect(await loadRequestOperations({
      storage,
      now: NOW + REQUEST_OPERATION_TTL_MS + 2_000
    })).toEqual([]);
    expect(storage.remove).toHaveBeenCalledWith(REQUEST_OPERATIONS_SESSION_KEY);
  });

  test("sanitizes completed responses before restoring them into a reopened popup", async () => {
    const data: Record<string, unknown> = {
      [REQUEST_OPERATIONS_SESSION_KEY]: [{
        id: "request_operation_3",
        action: "activate",
        itemIds: ["directoryRole:reader:/"],
        targets: ["directoryRole"],
        state: "complete",
        startedAt: NOW,
        updatedAt: NOW,
        response: {
          success: true,
          results: [
            {
              itemId: "directoryRole:reader:/",
              itemName: "Reader",
              success: false,
              error: "x".repeat(2_000),
              accessRecoveryTarget: "not-a-target"
            },
            { unexpected: true }
          ],
          errors: []
        }
      }]
    };
    const storage = makeStorage(data);

    const [operation] = await loadRequestOperations({ storage, now: NOW });

    expect(operation.response).toEqual({
      success: false,
      results: [{
        itemId: "directoryRole:reader:/",
        itemName: "Reader",
        success: false,
        error: "x".repeat(1_000)
      }],
      errors: [{
        itemId: "directoryRole:reader:/",
        itemName: "Reader",
        success: false,
        error: "x".repeat(1_000)
      }]
    });
    expect(storage.set).toHaveBeenCalledWith({
      [REQUEST_OPERATIONS_SESSION_KEY]: [operation]
    });
  });

  test("migrates legacy operation item IDs into their explicit tenant boundary", () => {
    const [operation] = sanitizeRequestOperations([{
      id: "request_operation_tenant_migration",
      action: "activate",
      itemIds: ["directoryRole:reader:/"],
      targets: ["directoryRole"],
      tenantId: "Tenant-One",
      principalId: "Principal-One",
      state: "running",
      startedAt: NOW,
      updatedAt: NOW
    }], NOW);

    expect(operation).toMatchObject({
      tenantId: "Tenant-One",
      principalId: "Principal-One",
      itemIds: ["tenant:tenant-one:directoryRole:reader:/"]
    });
    expect(operation.items?.[0].itemId).toBe("tenant:tenant-one:directoryRole:reader:/");
  });

  test("rejects a durable operation whose embedded tenant conflicts with its account context", async () => {
    const storage = makeStorage({});
    await expect(beginRequestOperation({
      id: "request_operation_tenant_mismatch",
      action: "activate",
      itemIds: ["tenant:tenant-two:directoryRole:reader:/"],
      targets: ["directoryRole"],
      tenantId: "tenant-one",
      startedAt: NOW
    }, { storage, now: NOW })).rejects.toThrow("same Microsoft tenant");
  });

  test("matches legacy completion results to a tenant-scoped durable operation", async () => {
    const storage = makeStorage({});
    await beginRequestOperation({
      id: "request_operation_tenant_completion",
      action: "activate",
      itemIds: ["directoryRole:reader:/"],
      targets: ["directoryRole"],
      tenantId: "tenant-one",
      principalId: "principal-one",
      startedAt: NOW
    }, { storage, now: NOW });
    await completeRequestOperation("request_operation_tenant_completion", {
      success: true,
      results: [{ itemId: "directoryRole:reader:/", itemName: "Reader", success: true }],
      errors: []
    }, { storage, now: NOW + 1_000 });

    const [operation] = await loadRequestOperations({ storage, now: NOW + 1_000 });
    expect(operation).toMatchObject({ state: "complete" });
    expect(operation.items?.[0]).toMatchObject({ state: "terminal", result: { success: true } });
  });

  test("keeps popup operation recovery inside the current tenant and principal", () => {
    const operations = sanitizeRequestOperations([
      {
        id: "request_operation_tenant_one",
        action: "activate",
        itemIds: ["directoryRole:reader:/"],
        targets: ["directoryRole"],
        tenantId: "tenant-one",
        principalId: "principal-one",
        state: "running",
        startedAt: NOW - 1_000,
        updatedAt: NOW - 1_000
      },
      {
        id: "request_operation_tenant_two",
        action: "activate",
        itemIds: ["directoryRole:reader:/"],
        targets: ["directoryRole"],
        tenantId: "tenant-two",
        principalId: "principal-two",
        state: "running",
        startedAt: NOW,
        updatedAt: NOW
      }
    ], NOW);

    expect(selectNextRequestOperation(operations, new Set(), {
      tenantId: "tenant-two",
      principalId: "principal-two"
    })?.id).toBe("request_operation_tenant_two");
    expect(selectNextRequestOperation(operations, new Set(), {
      tenantId: "tenant-three",
      principalId: "principal-three"
    })).toBeUndefined();
  });

  test("detects an in-flight conflict across legacy and tenant-scoped item IDs", async () => {
    const storage = makeStorage({});
    await beginRequestOperation({
      id: "request_operation_legacy_conflict",
      action: "activate",
      itemIds: ["directoryRole:reader:/"],
      targets: ["directoryRole"],
      tenantId: "tenant-one",
      principalId: "principal-one",
      startedAt: NOW
    }, { storage, now: NOW });

    await expect(beginRequestOperation({
      id: "request_operation_scoped_conflict",
      action: "activate",
      itemIds: ["tenant:tenant-one:directoryRole:reader:/"],
      targets: ["directoryRole"],
      tenantId: "tenant-one",
      principalId: "principal-one",
      startedAt: NOW + 1
    }, { storage, now: NOW + 1 })).rejects.toThrow("already in progress");
  });

  test("does not let journal cleanup overwrite an operation started after the initial read", async () => {
    const staleValue = [{ id: "invalid" }];
    const data: Record<string, unknown> = { [REQUEST_OPERATIONS_SESSION_KEY]: staleValue };
    let releaseInitialRead: ((value: Record<string, unknown>) => void) | undefined;
    let initialReadStarted: (() => void) | undefined;
    const initialReadReady = new Promise<void>((resolve) => { initialReadStarted = resolve; });
    let getCount = 0;
    const storage = {
      get: vi.fn((key: string) => {
        getCount += 1;
        if (getCount === 1) {
          initialReadStarted?.();
          return new Promise<Record<string, unknown>>((resolve) => { releaseInitialRead = resolve; });
        }
        return Promise.resolve({ [key]: data[key] });
      }),
      set: vi.fn(async (value: Record<string, unknown>) => { Object.assign(data, value); }),
      remove: vi.fn(async (key: string) => { delete data[key]; })
    };

    const loading = loadRequestOperations({ storage, now: NOW });
    await initialReadReady;
    await beginRequestOperation({
      id: "request_operation_race",
      action: "activate",
      itemIds: ["directoryRole:reader:/"],
      targets: ["directoryRole"],
      startedAt: NOW
    }, { storage, now: NOW });
    releaseInitialRead?.({ [REQUEST_OPERATIONS_SESSION_KEY]: staleValue });
    await expect(loading).resolves.toEqual([
      expect.objectContaining({ id: "request_operation_race", state: "running" })
    ]);

    expect(await loadRequestOperations({ storage, now: NOW })).toEqual([
      expect.objectContaining({ id: "request_operation_race", state: "running" })
    ]);
  });

  test("drops impossible timestamps and unsafe optional activation fields during recovery", () => {
    const base = {
      id: "request_operation_sanitize",
      action: "activate",
      itemIds: ["  directoryRole:reader:/  ", "   "],
      targets: ["directoryRole"],
      state: "running",
      startedAt: NOW,
      updatedAt: NOW
    };

    expect(sanitizeRequestOperations([{ ...base, startedAt: Number.MAX_VALUE }], NOW)).toEqual([]);
    expect(sanitizeRequestOperations([{ ...base, updatedAt: NOW + 10 * 60_000 }], NOW)).toEqual([]);
    expect(sanitizeRequestOperations([{ ...base, startedAt: NOW, updatedAt: NOW - 1 }], NOW)).toEqual([]);
    expect(sanitizeRequestOperations([{ ...base, itemIds: ["   "] }], NOW)).toEqual([]);

    expect(sanitizeRequestOperations([{ ...base, durationHours: 100 }], NOW)).toEqual([
      expect.objectContaining({
        itemIds: ["directoryRole:reader:/"]
      })
    ]);
    expect(sanitizeRequestOperations([{ ...base, durationHours: 100 }], NOW)[0]).not.toHaveProperty("durationHours");
  });

  test("retains unresolved work even when it appears after a large terminal journal", () => {
    const terminal = Array.from({ length: 1_001 }, (_, index) => ({
      id: `request_operation_terminal_${index}`,
      action: "activate",
      itemIds: [`directoryRole:reader-${index}:/`],
      targets: ["directoryRole"],
      state: "complete",
      startedAt: NOW - index - 1,
      updatedAt: NOW - index - 1,
      terminalAt: NOW - index - 1
    }));
    const running = {
      id: "request_operation_still_running",
      action: "activate",
      itemIds: ["directoryRole:critical:/"],
      targets: ["directoryRole"],
      state: "running",
      startedAt: NOW,
      updatedAt: NOW
    };

    const sanitized = sanitizeRequestOperations([...terminal, running], NOW);

    expect(sanitized).toHaveLength(101);
    expect(sanitized[0]).toMatchObject({ id: running.id, state: "running" });
    expect(sanitized.filter((operation) => operation.state === "complete")).toHaveLength(100);
  });
});

function makeStorage(data: Record<string, unknown>) {
  return {
    get: vi.fn(async (key: string) => ({ [key]: data[key] })),
    set: vi.fn(async (value: Record<string, unknown>) => {
      Object.assign(data, value);
    }),
    remove: vi.fn(async (key: string) => {
      delete data[key];
    })
  };
}
