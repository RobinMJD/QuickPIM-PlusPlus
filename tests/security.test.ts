import { describe, expect, test } from "vitest";
import {
  assertAllowedApiUrl,
  isAllowedPortalTokenSource,
  getAllowedTokenKindForUrl,
  sanitizeErrorMessage,
  validateCapturedToken
} from "../src/lib/security";
import { validateQuickPimMessage } from "../src/lib/messages";
import { buildActivationRequest } from "../src/lib/pim";
import type { ActivationItem } from "../src/lib/types";

const now = Date.parse("2026-05-18T12:00:00.000Z");

describe("security allowlists and token validation", () => {
  test("only allows Graph and Azure Management HTTPS API URLs plus Entra portal token sources", () => {
    expect(getAllowedTokenKindForUrl("https://graph.microsoft.com/v1.0/me")).toBe("graph");
    expect(getAllowedTokenKindForUrl("https://management.azure.com/subscriptions?api-version=2020-01-01")).toBe(
      "azureManagement"
    );
    expect(getAllowedTokenKindForUrl("https://login.microsoftonline.com/common/oauth2/v2.0/token")).toBeUndefined();
    expect(getAllowedTokenKindForUrl("http://graph.microsoft.com/v1.0/me")).toBeUndefined();
    expect(getAllowedTokenKindForUrl("https://evil.example/https://graph.microsoft.com/v1.0/me")).toBeUndefined();

    expect(() => assertAllowedApiUrl("https://evil.example/v1.0/me")).toThrow(/not allowed/i);
    expect(isAllowedPortalTokenSource("https://entra.microsoft.com/#view/Microsoft_Azure_PIMCommon/ActivationMenuBlade")).toBe(true);
    expect(isAllowedPortalTokenSource("https://evil.example/#view/Microsoft_Azure_PIMCommon/ActivationMenuBlade")).toBe(false);
  });

  test("rejects captured tokens with wrong audience, invalid format, or expired claims", () => {
    const graphToken = makeToken({
      aud: "https://graph.microsoft.com",
      exp: Math.floor((now + 10 * 60_000) / 1000),
      oid: "user-1"
    });

    expect(validateCapturedToken(graphToken, "graph", now)).toMatchObject({ ok: true });
    expect(validateCapturedToken(makeToken({ aud: "https://evil.example", exp: Math.floor((now + 60_000) / 1000), oid: "user-1" }), "graph", now)).toMatchObject({
      ok: false
    });
    expect(validateCapturedToken(makeToken({ aud: "https://graph.microsoft.com", exp: Math.floor((now + 60_000) / 1000) }), "graph", now)).toMatchObject({ ok: true });
    expect(validateCapturedToken(makeToken({ aud: "https://graph.microsoft.com", exp: Math.floor((now - 60_000) / 1000), oid: "user-1" }), "graph", now)).toMatchObject({
      ok: false
    });
    expect(validateCapturedToken("not-a-jwt", "graph", now)).toMatchObject({ ok: false });
    expect(
      validateCapturedToken(
        makeToken({
          aud: "https://management.core.windows.net/",
          exp: Math.floor((now + 10 * 60_000) / 1000)
        }),
        "azureManagement",
        now
      )
    ).toMatchObject({ ok: true });
  });

  test("redacts bearer tokens and long API payloads before displaying errors", () => {
    const token = makeToken({
      aud: "https://graph.microsoft.com",
      exp: Math.floor((now + 10 * 60_000) / 1000),
      oid: "user-1"
    });
    const message = sanitizeErrorMessage(`Authorization failed for Bearer ${token}. ${"x".repeat(400)}`);

    expect(message).not.toContain(token);
    expect(message).toContain("[redacted token]");
    expect(message.length).toBeLessThanOrEqual(260);
  });
});

describe("runtime message validation", () => {
  test("rejects unsupported and malformed privileged messages", () => {
    expect(validateQuickPimMessage({ action: "getTokenStatus" })).toEqual({ action: "getTokenStatus" });
    expect(validateQuickPimMessage({ action: "capturePortalTokens", tokens: ["a.b.c"], source: "entra" })).toEqual({
      action: "capturePortalTokens",
      tokens: ["a.b.c"],
      source: "entra"
    });
    expect(() => validateQuickPimMessage({ action: "manualSetToken", token: "abc" })).toThrow(/unsupported/i);
    expect(() => validateQuickPimMessage({ action: "capturePortalTokens", tokens: "abc" })).toThrow(/tokens/i);
    expect(() => validateQuickPimMessage({ action: "capturePortalTokens", tokens: ["x".repeat(9000)] })).toThrow(/token/i);
    expect(() => validateQuickPimMessage({ action: "activateItems", items: "not-array" })).toThrow(/items/i);
    expect(() => validateQuickPimMessage({ action: "activateItems", items: [], durationHours: 1 })).toThrow(
      /justification/i
    );
  });
});

describe("activation request validation", () => {
  const directoryRole: ActivationItem = {
    id: "directoryRole:reader:/",
    type: "directoryRole",
    sourceName: "Global Reader",
    displayName: "Global Reader",
    principalId: "user-1",
    roleDefinitionId: "reader",
    directoryScopeId: "/",
    scopeLabel: "Tenant",
    status: "eligible"
  };

  test("rejects invalid activation duration, oversized strings, and unsafe Azure scopes", () => {
    expect(() => buildActivationRequest(directoryRole, 25, "Need access")).toThrow(/duration/i);
    expect(() => buildActivationRequest(directoryRole, 1, "x".repeat(1025))).toThrow(/justification/i);
    expect(() =>
      buildActivationRequest(
        {
          id: "azureRole:bad:bad",
          type: "azureRole",
          sourceName: "Contributor",
          displayName: "Contributor",
          principalId: "user-1",
          roleDefinitionId: "/subscriptions/sub-1/providers/Microsoft.Authorization/roleDefinitions/contributor",
          scope: "https://evil.example/subscriptions/sub-1",
          scopeLabel: "Production",
          status: "eligible"
        },
        1,
        "Need access"
      )
    ).toThrow(/scope/i);
  });
});

function makeToken(payload: Record<string, unknown>): string {
  const encodedPayload = btoa(JSON.stringify(payload)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  return `header.${encodedPayload}.signature`;
}
