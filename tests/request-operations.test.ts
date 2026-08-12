import { describe, expect, test, vi } from "vitest";
import {
  REQUEST_OPERATIONS_SESSION_KEY,
  REQUEST_OPERATION_TTL_MS,
  beginRequestOperation,
  completeRequestOperation,
  dismissRequestOperations,
  failRequestOperation,
  getRequestOperationFingerprint,
  loadRequestOperations,
  sanitizeRequestOperations,
  touchRequestOperation
} from "../src/lib/requestOperations";

const NOW = Date.parse("2026-07-22T10:00:00.000Z");

describe("background request operation journal", () => {
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
