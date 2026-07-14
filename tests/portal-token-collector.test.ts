import { afterEach, describe, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

afterEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe("portal token collector", () => {
  test("forced scans resubmit unchanged tokens and wait for background capture", async () => {
    const token = createJwt({
      aud: "https://graph.microsoft.com",
      exp: Math.floor(Date.now() / 1000) + 3600
    });
    window.localStorage.setItem("msal-token", JSON.stringify({ accessToken: token }));

    let portalMessageListener: ((message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => boolean) | undefined;
    let pendingCaptureResponse: ((response: unknown) => void) | undefined;
    const runtimeSendMessage = vi.fn((_message: unknown, callback: (response: unknown) => void) => {
      if (runtimeSendMessage.mock.calls.length === 1) {
        callback({ success: true, data: { captured: ["graph"] } });
        return;
      }
      pendingCaptureResponse = callback;
    });
    const chromeMock = {
      runtime: {
        lastError: undefined,
        sendMessage: runtimeSendMessage,
        onMessage: {
          addListener: vi.fn((listener) => {
            portalMessageListener = listener;
          })
        }
      }
    };

    vi.stubGlobal("chrome", chromeMock);
    vi.stubGlobal("setInterval", vi.fn(() => 1));
    vi.stubGlobal("clearInterval", vi.fn());

    const collector = readFileSync(join(process.cwd(), "public/portalTokenCollector.js"), "utf8");
    new Function(collector)();

    await waitFor(() => expect(runtimeSendMessage).toHaveBeenCalledTimes(1));
    expect(portalMessageListener).toBeTypeOf("function");

    const sendResponse = vi.fn();
    expect(portalMessageListener?.({ action: "quickPimScanPortalTokens" }, {}, sendResponse)).toBe(true);
    await waitFor(() => expect(runtimeSendMessage).toHaveBeenCalledTimes(2));

    expect(sendResponse).not.toHaveBeenCalled();
    expect(runtimeSendMessage.mock.calls[1][0]).toMatchObject({
      action: "capturePortalTokens",
      tokens: [token]
    });

    pendingCaptureResponse?.({ success: true, data: { captured: ["graph"] } });
    await waitFor(() => expect(sendResponse).toHaveBeenCalledWith({
      success: true,
      data: { tokenCount: 1, captured: ["graph"] }
    }));
  });
});

function createJwt(payload: Record<string, unknown>): string {
  return [encodeBase64Url({ alg: "none" }), encodeBase64Url(payload), "signature"].join(".");
}

function encodeBase64Url(value: Record<string, unknown>): string {
  return btoa(JSON.stringify(value)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function waitFor(assertion: () => void, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw lastError;
}
