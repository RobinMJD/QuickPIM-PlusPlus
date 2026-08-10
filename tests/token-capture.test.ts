import { describe, expect, test, vi } from "vitest";
import { shouldAllowCapturedTokenIdentityChange } from "../src/lib/tokenCapture";

describe("captured token account changes", () => {
  test("allows an account change only from the tab the user is actively viewing", async () => {
    const tabs = {
      get: vi.fn(async (tabId: number) => ({ active: tabId === 7 }))
    };

    await expect(shouldAllowCapturedTokenIdentityChange(7, tabs)).resolves.toBe(true);
    await expect(shouldAllowCapturedTokenIdentityChange(8, tabs)).resolves.toBe(false);
  });

  test("fails closed for background requests and tabs that disappeared", async () => {
    const tabs = {
      get: vi.fn(async () => {
        throw new Error("Tab closed");
      })
    };

    await expect(shouldAllowCapturedTokenIdentityChange(-1, tabs)).resolves.toBe(false);
    await expect(shouldAllowCapturedTokenIdentityChange(12, tabs)).resolves.toBe(false);
    expect(tabs.get).toHaveBeenCalledTimes(1);
  });
});
