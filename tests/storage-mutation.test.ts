import { afterEach, describe, expect, test, vi } from "vitest";
import { createStorageMutationLock } from "../src/lib/storageMutation";

describe("cross-context storage mutation locks", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("independent callers serialize on the same Web Lock name", async () => {
    const queues = new Map<string, Promise<unknown>>();
    const request = vi.fn(<T>(name: string, operation: () => Promise<T>): Promise<T> => {
      const pending = (queues.get(name) || Promise.resolve()).then(operation);
      queues.set(name, pending.catch(() => undefined));
      return pending;
    });
    vi.stubGlobal("navigator", { locks: { request } });

    const firstContext = createStorageMutationLock("shared-storage");
    const secondContext = createStorageMutationLock("shared-storage");
    const order: string[] = [];

    await Promise.all([
      firstContext(async () => {
        order.push("first-start");
        await Promise.resolve();
        order.push("first-end");
      }),
      secondContext(async () => {
        order.push("second-start");
        order.push("second-end");
      })
    ]);

    expect(order).toEqual(["first-start", "first-end", "second-start", "second-end"]);
    expect(request).toHaveBeenNthCalledWith(1, "shared-storage", expect.any(Function));
    expect(request).toHaveBeenNthCalledWith(2, "shared-storage", expect.any(Function));
  });
});
