import { describe, expect, test } from "vitest";
import { getIdentityContext } from "../src/lib/identityContext";
import { stringifySupportReport } from "../src/lib/supportReport";
import { DEFAULT_SETTINGS } from "../src/lib/settings";
import { makeTokenStatus } from "../src/lib/token";
import type { ActivationItem, QuickPimDataCache, TokenStatus, TrackedPimRequestStore } from "../src/lib/types";

describe("safe account context", () => {
  test("extracts a display account and detects mixed portal identities", () => {
    const tokenStatus: TokenStatus = {
      graph: { hasToken: true, principalName: "admin@example.test", principalId: "principal-a", tenantId: "tenant-a" },
      graphTargets: {
        directoryRole: { hasToken: true, principalName: "admin@example.test", principalId: "principal-a", tenantId: "tenant-a" },
        pimGroup: { hasToken: true, principalName: "other@example.test", principalId: "principal-b", tenantId: "tenant-b" }
      },
      azureManagement: { hasToken: true, principalName: "admin@example.test", principalId: "principal-a", tenantId: "tenant-a" }
    };
    const context = getIdentityContext(tokenStatus);
    expect(context.label).toContain("admin@example.test");
    expect(context.mismatch).toBe(true);
    expect(context.identityCount).toBe(2);
  });

  test("reads a safe principal name from a captured JWT", () => {
    const now = Date.now();
    const token = makeJwt({
      aud: "https://graph.microsoft.com",
      exp: Math.floor(now / 1000) + 3600,
      tid: "tenant-a",
      oid: "principal-a",
      preferred_username: "admin@example.test"
    });
    expect(makeTokenStatus(token, now, "portal", now)).toMatchObject({ principalName: "admin@example.test" });
  });
});

describe("sanitized support reports", () => {
  test("exports aggregate diagnostics without request or role secrets", () => {
    const secretRoleName = "SECRET ROLE NAME";
    const secretReason = "SECRET JUSTIFICATION";
    const item: ActivationItem = {
      id: "directoryRole:secret-role:/",
      type: "directoryRole",
      sourceName: secretRoleName,
      displayName: secretRoleName,
      principalId: "principal-secret",
      roleDefinitionId: "secret-role",
      directoryScopeId: "/",
      scopeLabel: "Tenant",
      status: "eligible"
    };
    const cache: QuickPimDataCache = {
      eligibleByTarget: {
        directoryRole: { items: [item], errors: [], fetchedAt: 1, cacheKey: "safe" }
      }
    };
    const trackedRequests: TrackedPimRequestStore = {
      version: 1,
      requests: [{
        id: "tracked-secret",
        requestId: "request-secret",
        action: "activate",
        itemId: item.id,
        itemName: secretRoleName,
        itemType: "directoryRole",
        principalId: "principal-secret",
        status: "submitted",
        requestedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        justification: secretReason,
        checkCount: 0
      }]
    };
    const report = stringifySupportReport({
      appVersion: "9.9.9",
      buildTimestamp: "2026-01-01T00:00:00.000Z",
      settings: {
        ...structuredClone(DEFAULT_SETTINGS),
        savedJustifications: [secretReason],
        aliasesByItemId: { [item.id]: secretRoleName }
      },
      tokenStatus: {
        graph: { hasToken: true, tenantId: "tenant-secret", principalId: "principal-secret", principalName: "admin@example.test" },
        azureManagement: { hasToken: false }
      },
      dataCache: cache,
      trackedRequests,
      userAgent: "Browser/1.0 (private platform)"
    });
    expect(report).toContain('"directoryRole:eligible": 1');
    expect(report).toContain('"activate:submitted": 1');
    expect(report).not.toContain(secretRoleName);
    expect(report).not.toContain(secretReason);
    expect(report).not.toContain("admin@example.test");
    expect(report).not.toContain("request-secret");
  });
});

function makeJwt(payload: Record<string, unknown>): string {
  const encode = (value: Record<string, unknown>) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(payload)}.signature`;
}
