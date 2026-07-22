import { describe, expect, test, vi } from "vitest";
import {
  REQUEST_OPERATIONS_SESSION_KEY,
  REQUEST_OPERATION_TTL_MS,
  beginRequestOperation,
  completeRequestOperation,
  dismissRequestOperations,
  failRequestOperation,
  loadRequestOperations
} from "../src/lib/requestOperations";

const NOW = Date.parse("2026-07-22T10:00:00.000Z");

describe("background request operation journal", () => {
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
