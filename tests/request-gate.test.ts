import { describe, expect, test } from "vitest";
import { runWithActivationItemLock } from "../src/lib/requestGate";
import type { ActivationItem } from "../src/lib/types";

const role: ActivationItem = {
  id: "directoryRole:reader:/",
  type: "directoryRole",
  sourceName: "Reader",
  displayName: "Reader",
  principalId: "user-1",
  roleDefinitionId: "reader",
  directoryScopeId: "/",
  scopeLabel: "Tenant",
  status: "eligible"
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

describe("activation request locking", () => {
  test("blocks overlapping requests for the same logical item", async () => {
    const pending = deferred<void>();
    const first = runWithActivationItemLock(role, async () => pending.promise);

    await expect(runWithActivationItemLock({ ...role, id: "different-client-id", roleDefinitionId: "READER" }, async () => undefined))
      .rejects.toThrow("already in progress");

    pending.resolve();
    await first;
  });

  test("allows different items and releases a lock after failure", async () => {
    const otherRole = { ...role, id: "directoryRole:admin:/", roleDefinitionId: "admin" };
    await expect(Promise.all([
      runWithActivationItemLock(role, async () => "reader"),
      runWithActivationItemLock(otherRole, async () => "admin")
    ])).resolves.toEqual(["reader", "admin"]);

    await expect(runWithActivationItemLock(role, async () => {
      throw new Error("Microsoft rejected the request");
    })).rejects.toThrow("Microsoft rejected the request");
    await expect(runWithActivationItemLock(role, async () => "retried")).resolves.toBe("retried");
  });
});
