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
    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledTimes(1);

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

  test("continues watching after an initial capture so later scoped tokens are found", async () => {
    const firstToken = createJwt({
      aud: "https://graph.microsoft.com",
      exp: Math.floor(Date.now() / 1000) + 3600,
      tid: "tenant",
      oid: "user",
      scp: "RoleManagement.Read.Directory"
    });
    const laterToken = createJwt({
      aud: "https://graph.microsoft.com",
      exp: Math.floor(Date.now() / 1000) + 3600,
      tid: "tenant",
      oid: "user",
      scp: "PrivilegedAssignmentSchedule.ReadWrite.AzureADGroup"
    });
    window.localStorage.setItem("msal-token-1", firstToken);

    const runtimeSendMessage = vi.fn((_message: unknown, callback: (response: unknown) => void) => {
      callback({ success: true, data: { captured: ["graph"] } });
    });
    let intervalCallback: (() => void) | undefined;
    const clearIntervalMock = vi.fn();
    vi.stubGlobal("chrome", {
      runtime: {
        lastError: undefined,
        sendMessage: runtimeSendMessage,
        onMessage: { addListener: vi.fn() }
      }
    });
    vi.stubGlobal("setInterval", vi.fn((callback: () => void) => {
      intervalCallback = callback;
      return 1;
    }));
    vi.stubGlobal("clearInterval", clearIntervalMock);

    const collector = readFileSync(join(process.cwd(), "public/portalTokenCollector.js"), "utf8");
    new Function(collector)();
    await waitFor(() => expect(runtimeSendMessage).toHaveBeenCalledTimes(1));
    expect(clearIntervalMock).not.toHaveBeenCalled();

    window.localStorage.setItem("msal-token-2", laterToken);
    intervalCallback?.();
    await waitFor(() => expect(runtimeSendMessage).toHaveBeenCalledTimes(2));
    expect(runtimeSendMessage.mock.calls[1][0]).toMatchObject({
      tokens: expect.arrayContaining([firstToken, laterToken])
    });
  });

  test("collects more than twenty scoped API token candidates", async () => {
    const tokens = Array.from({ length: 25 }, (_, index) => createJwt({
      aud: "https://graph.microsoft.com",
      exp: Math.floor(Date.now() / 1000) + 3600 + index,
      tid: "tenant",
      oid: "user",
      scp: `Scope.${index}`
    }));
    tokens.forEach((token, index) => window.localStorage.setItem(`msal-token-${index}`, token));

    const runtimeSendMessage = vi.fn((_message: unknown, callback: (response: unknown) => void) => {
      callback({ success: true, data: { captured: ["graph"] } });
    });
    vi.stubGlobal("chrome", {
      runtime: {
        lastError: undefined,
        sendMessage: runtimeSendMessage,
        onMessage: { addListener: vi.fn() }
      }
    });
    vi.stubGlobal("setInterval", vi.fn(() => 1));
    vi.stubGlobal("clearInterval", vi.fn());

    const collector = readFileSync(join(process.cwd(), "public/portalTokenCollector.js"), "utf8");
    new Function(collector)();

    await waitFor(() => expect(runtimeSendMessage).toHaveBeenCalledTimes(1));
    expect(runtimeSendMessage.mock.calls[0][0]).toMatchObject({
      action: "capturePortalTokens",
      tokens: expect.arrayContaining(tokens)
    });
    expect((runtimeSendMessage.mock.calls[0][0] as {tokens: string[]}).tokens).toHaveLength(25);
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
