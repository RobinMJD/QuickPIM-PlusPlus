import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  DEACTIVATION_RETRY_KEY, acceptDeactivationRetry, cancelDeactivationRetry,
  getDeactivationRetryTime, isMinimumActiveDurationMessage, loadDeactivationRetries,
  offerDeactivationRetry, recoverInterruptedDeactivationRetries, runDueDeactivationRetries,
  type RetryStorage
} from "../src/lib/deactivationRetry";
import { validateQuickPimMessage } from "../src/lib/messages";
import type { ActivationItem, ActivationResponse, PimGroupItem } from "../src/lib/types";

const rejectedAt = Date.parse("2026-10-24T12:00:00Z");
const item: PimGroupItem = {
  id: "pimGroup:group-1:member", type: "pimGroup", tenantId: "tenant-1", principalId: "user-1",
  groupId: "group-1", accessId: "member", sourceName: "Admin group", displayName: "Admin group",
  scopeLabel: "Member", status: "active", activeAssignmentType: "activated",
  activeFrom: new Date(rejectedAt - 2 * 60_000).toISOString(),
  activeUntil: new Date(rejectedAt + 60 * 60_000).toISOString(),
  assignmentScheduleId: "schedule-1", assignmentScheduleInstanceId: "instance-1"
};

describe("one-shot deactivation retry", () => {
  let values: Record<string, unknown>;
  let storage: RetryStorage;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(rejectedAt);
    values = {};
    storage = {
      get: async (key) => ({ [key]: structuredClone(values[key]) }),
      set: async (next) => { Object.assign(values, structuredClone(next)); }
    };
  });
  afterEach(() => vi.useRealTimers());

  async function offer() {
    await offerDeactivationRetry(item, "Wrong activation selected", {}, storage);
    return (await loadDeactivationRetries(storage))[0];
  }
  async function queued() {
    const entry = await offer();
    await acceptDeactivationRetry(entry.id, storage);
    return entry;
  }
  function runner(active: ActivationItem[] = [item]) {
    const readActiveItems = vi.fn(async () => active);
    const submit = vi.fn(async (): Promise<ActivationResponse> => ({
      success: true, results: [{ itemId: item.id, itemName: item.displayName, success: true, requestId: "disable-1" }], errors: []
    }));
    return { storage, readActiveItems, submit };
  }

  test.each(["Minimum", "Miniumum"])("recognizes Microsoft's %s spelling without matching unrelated failures", (spelling) => {
    expect(isMinimumActiveDurationMessage(`The Active duration is too short. ${spelling} Required is 5 minutes.`)).toBe(true);
    expect(isMinimumActiveDurationMessage("Request timed out after 5 minutes")).toBe(false);
    expect(isMinimumActiveDurationMessage("The Active duration is too short. Minimum Required is 10 minutes.")).toBe(false);
  });

  test("uses the activation start plus five minutes and a small server-clock margin", () => {
    expect(getDeactivationRetryTime(item, rejectedAt)).toBe(rejectedAt + 3 * 60_000 + 5_000);
    expect(getDeactivationRetryTime({ ...item, activeFrom: undefined }, rejectedAt)).toBe(rejectedAt + 5 * 60_000 + 5_000);
    expect(getDeactivationRetryTime({ ...item, activeFrom: new Date(rejectedAt + 20_000).toISOString() }, rejectedAt)).toBe(rejectedAt + 5 * 60_000 + 5_000);
  });

  test("does nothing before the user accepts or before the deadline", async () => {
    const entry = await offer();
    const run = runner();
    await runDueDeactivationRetries(run);
    await acceptDeactivationRetry(entry.id, storage);
    await runDueDeactivationRetries(run);
    expect(run.readActiveItems).not.toHaveBeenCalled();
    expect(run.submit).not.toHaveBeenCalled();
  });

  test("persists an offer without raw API data or token fields and deduplicates repeated rejections", async () => {
    await offerDeactivationRetry({ ...item, raw: { accessToken: "must-not-store" } }, "Wrong activation selected", {}, storage);
    await offer();
    expect(await loadDeactivationRetries(storage)).toHaveLength(1);
    expect(JSON.stringify(values)).not.toContain("must-not-store");
    expect(JSON.stringify(values)).not.toContain('"raw"');
  });

  test("rechecks the exact activation and sends once despite overlapping alarm executions", async () => {
    const entry = await queued();
    vi.setSystemTime(entry.retryAt);
    const run = runner();
    await Promise.all([runDueDeactivationRetries(run), runDueDeactivationRetries(run)]);
    await runDueDeactivationRetries(run);
    expect(run.readActiveItems).toHaveBeenCalledTimes(1);
    expect(run.submit).toHaveBeenCalledTimes(1);
    expect((await loadDeactivationRetries(storage))[0].state).toBe("submitted");
  });

  test("cancellation prevents reads and writes even after the deadline", async () => {
    const entry = await queued();
    await cancelDeactivationRetry(entry.id, storage);
    vi.setSystemTime(entry.retryAt);
    const run = runner();
    await runDueDeactivationRetries(run);
    expect(run.readActiveItems).not.toHaveBeenCalled();
    expect(await loadDeactivationRetries(storage)).toEqual([]);
  });

  test.each([
    { tenantId: "tenant-2" }, { principalId: "user-2" },
    { assignmentScheduleId: "schedule-2" }, { assignmentScheduleInstanceId: "new-activation" },
    { accessId: "owner" }, { activeAssignmentType: "assigned" }, { status: "eligible" }
  ])("does not disable a different activation: %j", async (change) => {
    const entry = await queued();
    vi.setSystemTime(entry.retryAt);
    const run = runner([{ ...item, ...change } as ActivationItem]);
    await runDueDeactivationRetries(run);
    expect(run.submit).not.toHaveBeenCalled();
    expect((await loadDeactivationRetries(storage))[0]).toMatchObject({ state: "failed", detail: expect.stringContaining("original activation") });
  });

  test("stops if access expires or Microsoft cannot confirm the current assignment", async () => {
    const entry = await queued();
    vi.setSystemTime(entry.retryAt);
    const run = runner();
    run.readActiveItems.mockRejectedValue(new Error("Original account needs sign-in"));
    await runDueDeactivationRetries(run);
    expect(run.submit).not.toHaveBeenCalled();
    expect((await loadDeactivationRetries(storage))[0].state).toBe("failed");
  });

  test("does not retry a failed or uncertain automatic write again", async () => {
    const entry = await queued();
    vi.setSystemTime(entry.retryAt);
    const run = runner();
    run.submit.mockResolvedValue({ success: false, results: [{ itemId: item.id, itemName: item.displayName, success: false, outcomeUnknown: true, error: "Result unknown. Check Microsoft PIM." }], errors: [] });
    await runDueDeactivationRetries(run);
    await runDueDeactivationRetries(run);
    expect(run.submit).toHaveBeenCalledTimes(1);
    expect((await loadDeactivationRetries(storage))[0]).toMatchObject({ state: "failed", detail: expect.stringContaining("Result unknown") });
  });

  test("does not issue stale writes after the browser missed the bounded retry window", async () => {
    const entry = await queued();
    vi.setSystemTime(entry.retryAt + 16 * 60_000);
    const run = runner();
    await runDueDeactivationRetries(run);
    expect(run.readActiveItems).not.toHaveBeenCalled();
    expect((await loadDeactivationRetries(storage))[0].state).toBe("failed");
  });

  test("worker restart preserves queued intent but never replays an interrupted attempt", async () => {
    const entry = await queued();
    await recoverInterruptedDeactivationRetries(storage);
    expect((await loadDeactivationRetries(storage))[0].state).toBe("queued");
    const entries = values[DEACTIVATION_RETRY_KEY] as Array<Record<string, unknown>>;
    entries[0].state = "running";
    await recoverInterruptedDeactivationRetries(storage);
    vi.setSystemTime(entry.retryAt);
    const run = runner();
    await runDueDeactivationRetries(run);
    expect(run.submit).not.toHaveBeenCalled();
    expect((await loadDeactivationRetries(storage))[0]).toMatchObject({ state: "failed", detail: expect.stringContaining("interrupted") });
  });

  test("will not queue an item whose exact activation identifiers are missing", async () => {
    await expect(offerDeactivationRetry({ ...item, assignmentScheduleInstanceId: undefined }, "", {}, storage)).rejects.toThrow(/exact activation/);
    expect(await loadDeactivationRetries(storage)).toEqual([]);
  });

  test("validates retry messages and ignores attempts to supply a new target or time", () => {
    expect(validateQuickPimMessage({ action: "acceptDeactivationRetry", retryId: "known-offer", item: { groupId: "other" }, retryAt: 1 }))
      .toEqual({ action: "acceptDeactivationRetry", retryId: "known-offer" });
    expect(() => validateQuickPimMessage({ action: "cancelDeactivationRetry", retryId: "../bad" })).toThrow(/identifier/);
  });
});
