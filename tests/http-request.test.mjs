import { afterEach, describe, expect, test, vi } from "vitest";
import { fetchWithPolicy, getRetryDelayMs } from "../scripts/http-request.mjs";

afterEach(() => vi.unstubAllGlobals());

describe("Store HTTP request policy", () => {
  test("retries bounded transient responses", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("busy", { status: 503, headers: { "retry-after": "0" } }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const response = await fetchWithPolicy("https://store.example/status", {}, { attempts: 2 });
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("aborts a stalled request at its timeout", async () => {
    vi.stubGlobal("fetch", vi.fn((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    })));
    await expect(fetchWithPolicy("https://store.example/hang", {}, { timeoutMs: 20 })).rejects.toThrow(/timed out/i);
  });

  test("caps Retry-After delays", () => {
    expect(getRetryDelayMs("999", 1)).toBe(10_000);
    expect(getRetryDelayMs("0", 1)).toBe(0);
  });
});
