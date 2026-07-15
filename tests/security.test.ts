import { describe, expect, test } from "vitest";
import {
  assertAllowedApiUrl,
  isAllowedPortalTokenSource,
  getAllowedTokenKindForUrl,
  sanitizeErrorMessage,
  validateCapturedToken
} from "../src/lib/security";
import {
  getGraphTokenAuthStrengthScore,
  getGraphTokenOverallScore,
  getGraphTokenTargetScore,
  getGraphTokenTargets,
  hasGraphActivationScope
} from "../src/lib/graphTokenCapabilities";
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
      aud: "https://graph.microsoft.com/",
      exp: Math.floor((now + 10 * 60_000) / 1000),
      oid: "user-1"
    });

    expect(validateCapturedToken(graphToken, "graph", now)).toMatchObject({ ok: true });
    expect(validateCapturedToken(makeToken({ aud: "https://evil.example", exp: Math.floor((now + 60_000) / 1000), oid: "user-1" }), "graph", now)).toMatchObject({
      ok: false
    });
    expect(validateCapturedToken(makeToken({ aud: "https://graph.microsoft.com", exp: Math.floor((now + 60_000) / 1000), tid: undefined, oid: undefined }), "graph", now)).toMatchObject({ ok: false });
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

  test("replaces encoded claims challenges with a useful action", () => {
    const claims = encodeURIComponent(JSON.stringify({ access_token: { acrs: { essential: true, value: "c1" } } }));
    const message = sanitizeErrorMessage(`Authorization failed. &claims=${claims}`);

    expect(message).toBe(
      "Microsoft requires an additional sign-in or MFA challenge before this activation can continue. Open the matching Microsoft portal page, complete the prompt, then retry."
    );
    expect(message).not.toContain(claims);
  });
});

describe("Graph token capability detection", () => {
  test("detects PIM group Graph tokens independently from Entra role tokens", () => {
    const directoryRoleToken = {
      scp: "RoleEligibilitySchedule.Read.Directory RoleManagement.Read.Directory",
      exp: Math.floor((now + 10 * 60_000) / 1000)
    };
    const pimGroupToken = {
      scp: "PrivilegedEligibilitySchedule.Read.AzureADGroup PrivilegedAssignmentSchedule.Read.AzureADGroup",
      exp: Math.floor((now + 10 * 60_000) / 1000)
    };

    expect(getGraphTokenTargets(directoryRoleToken)).toEqual(["directoryRole"]);
    expect(getGraphTokenTargets(pimGroupToken)).toEqual(["pimGroup"]);
    expect(getGraphTokenTargetScore(pimGroupToken, "pimGroup")).toBeGreaterThan(0);
    expect(getGraphTokenTargetScore(pimGroupToken, "directoryRole")).toBe(0);
    expect(getGraphTokenOverallScore(pimGroupToken)).toBeGreaterThan(0);
  });

  test("scores activation-capable PIM group tokens above read-only tokens", () => {
    const readOnlyToken = {
      scp: "PrivilegedEligibilitySchedule.Read.AzureADGroup PrivilegedAssignmentSchedule.Read.AzureADGroup RoleManagementPolicy.Read.AzureADGroup",
      exp: Math.floor((now + 10 * 60_000) / 1000)
    };
    const activationToken = {
      scp: "PrivilegedAssignmentSchedule.ReadWrite.AzureADGroup",
      exp: Math.floor((now + 10 * 60_000) / 1000)
    };

    expect(hasGraphActivationScope(readOnlyToken, "pimGroup")).toBe(false);
    expect(hasGraphActivationScope(activationToken, "pimGroup")).toBe(true);
    expect(getGraphTokenTargetScore(activationToken, "pimGroup")).toBeGreaterThan(getGraphTokenTargetScore(readOnlyToken, "pimGroup"));
  });

  test("detects MFA and authentication-context claims on portal Graph tokens", () => {
    const regularActivationToken = {
      scp: "RoleAssignmentSchedule.ReadWrite.Directory",
      exp: Math.floor((now + 60 * 60_000) / 1000)
    };
    const challengedActivationToken = {
      ...regularActivationToken,
      amr: ["fido", "rsa", "mfa"],
      acrs: ["p1", "c1", "c2", "c3", "pfdr"]
    };

    expect(getGraphTokenTargetScore(challengedActivationToken, "directoryRole")).toBe(
      getGraphTokenTargetScore(regularActivationToken, "directoryRole")
    );
    expect(getGraphTokenAuthStrengthScore(challengedActivationToken)).toBeGreaterThan(
      getGraphTokenAuthStrengthScore(regularActivationToken)
    );
  });
});

describe("runtime message validation", () => {
  test("rejects unsupported and malformed privileged messages", () => {
    expect(validateQuickPimMessage({ action: "getTokenStatus" })).toEqual({ action: "getTokenStatus" });
    expect(validateQuickPimMessage({ action: "refreshPortalTokens" })).toEqual({ action: "refreshPortalTokens" });
    expect(validateQuickPimMessage({ action: "openPortalRecoveryTabs", targets: ["pimGroup", "pimGroup", "azureRole"] })).toEqual({
      action: "openPortalRecoveryTabs",
      targets: ["pimGroup", "azureRole"]
    });
    expect(validateQuickPimMessage({ action: "closePortalRecoveryTabs", targets: ["directoryRole"] })).toEqual({
      action: "closePortalRecoveryTabs",
      targets: ["directoryRole"]
    });
    expect(validateQuickPimMessage({ action: "getPortalRecoveryStatus" })).toEqual({ action: "getPortalRecoveryStatus" });
    expect(validateQuickPimMessage({ action: "focusPortalRecoveryTabs" })).toEqual({ action: "focusPortalRecoveryTabs" });
    expect(validateQuickPimMessage({ action: "getActivationSnapshot", targets: ["directoryRole", "directoryRole", "azureRole"] })).toEqual({
      action: "getActivationSnapshot",
      targets: ["directoryRole", "azureRole"]
    });
    expect(validateQuickPimMessage({ action: "refreshTrackedRequests", requestIds: ["request-1", "request-1", " request-2 "] })).toEqual({
      action: "refreshTrackedRequests",
      requestIds: ["request-1", "request-2"]
    });
    expect(validateQuickPimMessage({ action: "capturePortalTokens", tokens: ["a.b.c"], source: "entra" })).toEqual({
      action: "capturePortalTokens",
      tokens: ["a.b.c"],
      source: "entra"
    });
    const scopedTokens = Array.from({ length: 25 }, (_, index) => `header.payload${index}.signature`);
    expect(validateQuickPimMessage({
      action: "capturePortalTokens",
      tokens: [scopedTokens[0], ...scopedTokens, scopedTokens[0]]
    })).toMatchObject({
      action: "capturePortalTokens",
      tokens: scopedTokens
    });
    expect(() => validateQuickPimMessage({ action: "manualSetToken", token: "abc" })).toThrow(/unsupported/i);
    expect(() => validateQuickPimMessage({ action: "openPortalRecoveryTabs", targets: [] })).toThrow(/must not be empty/i);
    expect(() => validateQuickPimMessage({ action: "capturePortalTokens", tokens: "abc" })).toThrow(/tokens/i);
    expect(() => validateQuickPimMessage({ action: "capturePortalTokens", tokens: ["x".repeat(9000)] })).toThrow(/token/i);
    expect(() => validateQuickPimMessage({ action: "refreshTrackedRequests", requestIds: "request-1" })).toThrow(/identifiers/i);
    expect(() => validateQuickPimMessage({ action: "activateItems", items: "not-array" })).toThrow(/items/i);
    expect(() => validateQuickPimMessage({ action: "activateItems", items: [], durationHours: 1 })).toThrow(/between 1 and 100/i);
    const duplicateRole = {
      id: "directoryRole:reader:/",
      type: "directoryRole",
      principalId: "user",
      status: "eligible",
      roleDefinitionId: "reader",
      directoryScopeId: "/"
    };
    expect(() => validateQuickPimMessage({
      action: "activateItems",
      items: [duplicateRole, { ...duplicateRole, id: "different-client-id", roleDefinitionId: "READER" }],
      durationHours: 1,
      justification: "Investigate production issue"
    })).toThrow(/duplicate/i);
    expect(() => validateQuickPimMessage({
      action: "activateItems",
      items: [duplicateRole],
      durationHours: 0.25,
      justification: "Investigate production issue"
    })).toThrow(/between 0.5 and 24/i);
    expect(() => validateQuickPimMessage({
      action: "activateItems",
      items: [{ ...duplicateRole, activationRequirements: { maxDurationHours: 2 } }],
      durationHours: 4,
      justification: "Investigate production issue"
    })).toThrow(/policy maximum/i);
    expect(() => validateQuickPimMessage({
      action: "deactivateItems",
      items: [{
        id: "directoryRole:reader:/",
        type: "directoryRole",
        principalId: "user",
        status: "active",
        roleDefinitionId: "reader",
        directoryScopeId: "/",
        activeAssignmentType: "assigned",
        assignmentScheduleId: "assigned-schedule"
      }]
    })).toThrow(/activated through PIM/i);
    expect(() => validateQuickPimMessage({
      action: "activateItems",
      items: [{ id: "x", type: "unknown", principalId: "user", status: "eligible" }],
      durationHours: 1,
      justification: "Need access"
    })).toThrow(/unsupported/i);
    expect(() => validateQuickPimMessage({
      action: "activateItems",
      items: Array.from({ length: 101 }, () => ({
        id: "directoryRole:reader:/", type: "directoryRole", principalId: "user", status: "eligible",
        roleDefinitionId: "reader", directoryScopeId: "/"
      })),
      durationHours: 1,
      justification: "Need access"
    })).toThrow(/100/i);
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
    expect(() => buildActivationRequest(directoryRole, 0.25, "Need production access")).toThrow(/duration/i);
    expect(() => buildActivationRequest(directoryRole, 25, "Need access")).toThrow(/duration/i);
    expect(() => buildActivationRequest(
      { ...directoryRole, activationRequirements: { maxDurationHours: 2 } },
      4,
      "Need production access"
    )).toThrow(/policy maximum/i);
    expect(() => buildActivationRequest(directoryRole, 1, "x".repeat(1025))).toThrow(/justification/i);
    expect(() => buildActivationRequest(directoryRole, 1, "BAU")).toThrow(/generic/i);
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
  const encodedPayload = btoa(JSON.stringify({ tid: "tenant-1", oid: "user-1", ...payload })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  return `header.${encodedPayload}.signature`;
}
