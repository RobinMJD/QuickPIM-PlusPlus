import { afterEach, describe, expect, test, vi } from "vitest";
import { fetchMicrosoftApi } from "../src/lib/microsoftFetch";

const url = "https://graph.microsoft.com/v1.0/me";
describe("Microsoft response deadlines", () => {
  afterEach(() => vi.useRealTimers());

  test("keeps the deadline through a stalled body after headers arrive", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const request = fetchMicrosoftApi(url, {}, 1000, () => new Promise(() => undefined), undefined,
      vi.fn(async (_, init) => { signal = init?.signal as AbortSignal; return new Response("{}"); }));
    const result = expect(request).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(1000);
    await result;
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("rejects an error-body parser even if it swallows the abort", async () => {
    vi.useFakeTimers();
    const request = fetchMicrosoftApi(url, {}, 1000, async () => {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return { success: true };
    }, undefined, vi.fn(async () => new Response("", { status: 503 })));
    const result = expect(request).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(1000);
    await result;
    await vi.advanceTimersByTimeAsync(1000);
  });

  test("parent cancellation still aborts a response body and stops waiting", async () => {
    const parent = new AbortController();
    let signal: AbortSignal | undefined;
    const read = vi.fn(() => new Promise<object>(() => undefined));
    const request = fetchMicrosoftApi(url, {}, 1000, read, parent.signal,
      vi.fn(async (_, init) => { signal = init?.signal as AbortSignal; return new Response("{}"); }));
    await vi.waitFor(() => expect(read).toHaveBeenCalled());
    const result = expect(request).rejects.toThrow(/canceled/);
    parent.abort();
    await result;
    expect(signal?.aborted).toBe(true);
  });

  test("does not start a request after its parent has been canceled", async () => {
    const parent = new AbortController(); parent.abort();
    const fetcher = vi.fn();
    await expect(fetchMicrosoftApi(url, {}, 1000, (response) => response.json(), parent.signal, fetcher)).rejects.toThrow(/canceled/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  test("preserves destination and fetch security controls until successful parsing", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async () => new Response('{"ok":true}'));
    expect(await fetchMicrosoftApi(url, { credentials: "include", redirect: "follow" }, 1000,
      (response) => response.json(), undefined, fetcher)).toEqual({ ok: true });
    expect(fetcher).toHaveBeenCalledWith(url, expect.objectContaining({ credentials: "omit", redirect: "error", referrerPolicy: "no-referrer" }));
    expect(vi.getTimerCount()).toBe(0);
    fetcher.mockClear();
    await expect(fetchMicrosoftApi("https://evil.example/me", {}, 1000, (r) => r.json(), undefined, fetcher)).rejects.toThrow(/not allowed/);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
