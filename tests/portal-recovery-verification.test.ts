import { describe, expect, test } from "vitest";
import { buildTargetCacheKeys } from "../src/lib/access";
import { getApiVerifiedPortalRecoveryTargets } from "../src/lib/portalRecoveryVerification";
import type {
  AccessSetupTarget,
  CachedActivationEntry,
  QuickPimDataCache,
  TokenStatus
} from "../src/lib/types";

const JOURNEY_CREATED_AT = 1_000;
const FETCHED_AT = 2_000;

function tokenStatus(): TokenStatus {
  return {
    graph: {
      hasToken: true,
      capturedAt: 1_500,
      tenantId: "tenant-a",
      principalId: "user-a"
    },
    graphTargets: {
      directoryRole: {
        hasToken: true,
        capturedAt: 1_500,
        tenantId: "tenant-a",
        principalId: "user-a",
        grantedScopes: ["RoleAssignmentSchedule.ReadWrite.Directory"]
      },
      pimGroup: {
        hasToken: true,
        capturedAt: 1_500,
        tenantId: "tenant-a",
        principalId: "user-a",
        grantedScopes: ["PrivilegedAssignmentSchedule.ReadWrite.AzureADGroup"]
      }
    },
    azureManagement: {
      hasToken: true,
      capturedAt: 1_500,
      tenantId: "tenant-a",
      principalId: "user-a"
    }
  };
}

function verifiedEntry(
  target: AccessSetupTarget,
  operation: "eligible" | "active",
  cacheKey: string,
  overrides: Partial<CachedActivationEntry> = {}
): CachedActivationEntry {
  return {
    items: [],
    errors: [],
    fetchedAt: FETCHED_AT,
    refreshStartedAt: FETCHED_AT - 1,
    cacheKey,
    diagnostics: [{
      target,
      operation,
      success: true,
      checkedAt: new Date(FETCHED_AT).toISOString()
    }],
    ...overrides
  };
}

function verifiedCache(status: TokenStatus, target: AccessSetupTarget): QuickPimDataCache {
  const cacheKey = buildTargetCacheKeys(status, [target])[target]!;
  return {
    version: 2,
    eligibleByTarget: {
      [target]: verifiedEntry(target, "eligible", cacheKey)
    },
    activeByTarget: {
      [target]: verifiedEntry(target, "active", cacheKey)
    }
  };
}

describe("portal recovery API verification", () => {
  test.each<AccessSetupTarget>(["directoryRole", "pimGroup", "azureRole"])(
    "accepts empty %s results only after both current-token endpoints succeed",
    (target) => {
      const status = tokenStatus();
      expect(getApiVerifiedPortalRecoveryTargets({
        tokenStatus: status,
        cache: verifiedCache(status, target),
        targets: [target],
        journeyCreatedAt: JOURNEY_CREATED_AT
      })).toEqual([target]);
    }
  );

  test("rejects a cache written for an older token generation", () => {
    const status = tokenStatus();
    const cache = verifiedCache(status, "pimGroup");
    cache.activeByTarget!.pimGroup!.cacheKey = "pimGroup:tenant-a:user-a:old:generation=1";

    expect(getApiVerifiedPortalRecoveryTargets({
      tokenStatus: status,
      cache,
      targets: ["pimGroup"],
      journeyCreatedAt: JOURNEY_CREATED_AT
    })).toEqual([]);
  });

  test("rejects stale, partial, or failed endpoint checks", () => {
    const status = tokenStatus();
    const cacheKey = buildTargetCacheKeys(status, ["directoryRole"])["directoryRole"]!;
    const cases: QuickPimDataCache[] = [
      {
        eligibleByTarget: { directoryRole: verifiedEntry("directoryRole", "eligible", cacheKey) }
      },
      {
        eligibleByTarget: {
          directoryRole: verifiedEntry("directoryRole", "eligible", cacheKey, {
            fetchedAt: JOURNEY_CREATED_AT - 1
          })
        },
        activeByTarget: { directoryRole: verifiedEntry("directoryRole", "active", cacheKey) }
      },
      {
        eligibleByTarget: { directoryRole: verifiedEntry("directoryRole", "eligible", cacheKey) },
        activeByTarget: {
          directoryRole: verifiedEntry("directoryRole", "active", cacheKey, {
            errors: ["Forbidden"]
          })
        }
      },
      {
        eligibleByTarget: { directoryRole: verifiedEntry("directoryRole", "eligible", cacheKey) },
        activeByTarget: {
          directoryRole: verifiedEntry("directoryRole", "active", cacheKey, {
            diagnostics: [{
              target: "directoryRole",
              operation: "active",
              success: false,
              checkedAt: new Date(FETCHED_AT).toISOString(),
              error: "Forbidden"
            }]
          })
        }
      }
    ];

    for (const cache of cases) {
      expect(getApiVerifiedPortalRecoveryTargets({
        tokenStatus: status,
        cache,
        targets: ["directoryRole"],
        journeyCreatedAt: JOURNEY_CREATED_AT
      })).toEqual([]);
    }
  });

  test("keeps a known read-only PIM Groups token unverified for activation recovery", () => {
    const status = tokenStatus();
    status.graphTargets!.pimGroup!.grantedScopes = ["PrivilegedEligibilitySchedule.Read.AzureADGroup"];

    expect(getApiVerifiedPortalRecoveryTargets({
      tokenStatus: status,
      cache: verifiedCache(status, "pimGroup"),
      targets: ["pimGroup"],
      journeyCreatedAt: JOURNEY_CREATED_AT
    })).toEqual([]);
  });
});
