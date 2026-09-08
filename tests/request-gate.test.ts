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

  test("locks the same role independently for tenant-wide and administrative-unit requests", async () => {
    const tenantRole = { ...role, tenantId: "tenant-1" };
    const auRole = {
      ...tenantRole,
      id: "directoryRole:reader:/administrativeUnits/au-1",
      directoryScopeId: "/administrativeUnits/au-1"
    };
    const pending = deferred<void>();
    const tenantRequest = runWithActivationItemLock(tenantRole, async () => pending.promise);
    const auRequest = runWithActivationItemLock(auRole, async () => pending.promise);

    try {
      await expect(runWithActivationItemLock({
        ...auRole,
        id: "directoryRole:reader:/administrativeUnits/au-2",
        directoryScopeId: "/administrativeUnits/au-2"
      }, async () => "au-2 accepted")).resolves.toBe("au-2 accepted");
      await expect(runWithActivationItemLock({
        ...auRole,
        id: "same-au-different-client-id",
        roleDefinitionId: "READER",
        directoryScopeId: "/AdministrativeUnits/AU-1/"
      }, async () => undefined)).rejects.toThrow("already in progress");
    } finally {
      pending.resolve();
      await Promise.all([tenantRequest, auRequest]);
    }
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
