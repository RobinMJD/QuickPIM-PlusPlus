import { afterEach, describe, expect, test, vi } from "vitest";
import { OperationTimeoutError, withTimeout } from "../src/lib/async";
import { sendRuntimeMessage } from "../src/lib/runtimeMessaging";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("bounded asynchronous operations", () => {
  test("rejects an operation that does not settle within its deadline", async () => {
    await expect(withTimeout(new Promise(() => undefined), 5, "Refresh timed out.")).rejects.toEqual(
      expect.objectContaining({ name: "OperationTimeoutError", message: "Refresh timed out." })
    );
  });

  test("bounds Chrome runtime messages so UI callers can leave loading state", async () => {
    vi.stubGlobal("chrome", {
      runtime: {
        sendMessage: vi.fn(() => new Promise(() => undefined))
      }
    });

    await expect(sendRuntimeMessage(
      { action: "getActivationSnapshot" },
      { timeoutMs: 5, timeoutMessage: "Access refresh timed out." }
    )).rejects.toBeInstanceOf(OperationTimeoutError);
  });
});
