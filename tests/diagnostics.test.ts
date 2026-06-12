import { describe, expect, test } from "vitest";
import {
  buildAccessCapabilityItems,
  classifyAccessFailure,
  summarizeAccessDiagnostics
} from "../src/lib/access";
import type { AccessDiagnostic, QuickPimDataCache, TokenStatus } from "../src/lib/types";

describe("capability diagnostics", () => {
  test("classifies safe failure kinds from sanitized error text", () => {
    expect(classifyAccessFailure("Graph token is missing.")).toBe("missingToken");
    expect(classifyAccessFailure("Captured token expired. Refresh in portal.")).toBe("expiredToken");
    expect(classifyAccessFailure("Authorization failed due to missing permission scope PrivilegedAssignmentSchedule.Read.AzureADGroup")).toBe("missingCapability");
    expect(classifyAccessFailure("403 Forbidden")).toBe("forbidden");
    expect(classifyAccessFailure("Microsoft requires an additional sign-in or MFA challenge before this activation can continue.")).toBe("claimsChallenge");
    expect(classifyAccessFailure("Failed to fetch")).toBe("network");
    expect(classifyAccessFailure("Unexpected problem")).toBe("unknown");
  });

  test("summarizes last success and last failure independently per feature", () => {
    const diagnostics: AccessDiagnostic[] = [
      {
        target: "pimGroup",
        success: true,
        checkedAt: "2026-05-18T12:00:00.000Z",
        operation: "eligible",
        endpointLabel: "PIM group eligibility"
      },
      {
        target: "pimGroup",
        success: false,
        checkedAt: "2026-05-18T12:05:00.000Z",
        operation: "active",
        endpointLabel: "PIM group active assignments",
        failureKind: "missingCapability",
        error: "PIM Groups access is limited in the captured portal token."
      }
    ];

    expect(summarizeAccessDiagnostics(diagnostics)).toMatchObject({
      lastSuccess: {
        operation: "eligible",
        endpointLabel: "PIM group eligibility"
      },
      lastFailure: {
        operation: "active",
        failureKind: "missingCapability"
      }
    });
  });

  test("surfaces last success and failure metadata in Access Setup capability items", () => {
    const tokenStatus: TokenStatus = {
      graph: { hasToken: true, isExpired: false },
      graphTargets: { pimGroup: { hasToken: true, isExpired: false } },
      azureManagement: { hasToken: true, isExpired: false }
    };
    const cache: QuickPimDataCache = {
      eligibleByTarget: {
        pimGroup: {
          items: [],
          errors: [],
          fetchedAt: Date.now(),
          diagnostics: [
            {
              target: "pimGroup",
              success: true,
              checkedAt: "2026-05-18T12:00:00.000Z",
              operation: "eligible",
              endpointLabel: "PIM group eligibility"
            }
          ]
        }
      },
      activeByTarget: {
        pimGroup: {
          items: [],
          errors: ["PIM Groups access is limited in the captured portal token."],
          fetchedAt: Date.now(),
          diagnostics: [
            {
              target: "pimGroup",
              success: false,
              checkedAt: "2026-05-18T12:05:00.000Z",
              operation: "active",
              endpointLabel: "PIM group active assignments",
              failureKind: "missingCapability",
              error: "PIM Groups access is limited in the captured portal token."
            }
          ]
        }
      }
    };

    expect(buildAccessCapabilityItems(tokenStatus, cache, ["pimGroup"])[0]).toMatchObject({
      target: "pimGroup",
      lastSuccessAt: "2026-05-18T12:00:00.000Z",
      lastSuccessOperation: "eligible",
      lastFailureAt: "2026-05-18T12:05:00.000Z",
      failureKind: "missingCapability",
      recommendedAction: "Reload the PIM Groups portal page, then recheck access."
    });
  });
});
