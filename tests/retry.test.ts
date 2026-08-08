import { describe, expect, test, vi } from "vitest";
import { isTransientMicrosoftFailure } from "../src/lib/requestOutcome";
import { retryOnceIf } from "../src/lib/retry";

describe("bounded retries", () => {
  test("retries a transient failure once", async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(new Error("503 Service Unavailable"))
      .mockResolvedValue("ready");

    await expect(retryOnceIf(
      operation,
      (error) => isTransientMicrosoftFailure(String(error))
    )).resolves.toBe("ready");
    expect(operation).toHaveBeenCalledTimes(2);
  });

  test("does not retry a permanent authorization failure", async () => {
    const operation = vi.fn().mockRejectedValue(new Error("403 Forbidden"));

    await expect(retryOnceIf(
      operation,
      (error) => isTransientMicrosoftFailure(String(error))
    )).rejects.toThrow("403 Forbidden");
    expect(operation).toHaveBeenCalledTimes(1);
  });

  test("never retries more than once", async () => {
    const operation = vi.fn().mockRejectedValue(new Error("429 Too Many Requests"));

    await expect(retryOnceIf(
      operation,
      (error) => isTransientMicrosoftFailure(String(error))
    )).rejects.toThrow("429 Too Many Requests");
    expect(operation).toHaveBeenCalledTimes(2);
  });
});
