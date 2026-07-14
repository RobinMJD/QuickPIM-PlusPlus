import { describe, expect, test } from "vitest";
import {
  buildAccessCapabilityItems,
  buildTargetCacheKey,
  buildTokenCacheKey,
  getAccessSetupTargets,
  getPortalUrlsForTargets
} from "../src/lib/access";
import { ENTRA_GRAPH_BOOTSTRAP_URLS, ENTRA_PORTAL_URLS } from "../src/lib/popupModel";
import type { QuickPimDataCache, TokenStatus } from "../src/lib/types";

const missingTokens: TokenStatus = {
  graph: { hasToken: false },
  azureManagement: { hasToken: false }
};

const freshTokensWithoutVisibleScopes: TokenStatus = {
  graph: {
    hasToken: true,
    isExpired: false,
    tokenAge: 1,
    grantedScopes: []
  },
  azureManagement: {
    hasToken: true,
    isExpired: false,
    tokenAge: 1
  }
};

const freshTokensWithPimGroupReadOnlyScope: TokenStatus = {
  graph: {
    hasToken: true,
    isExpired: false,
    tokenAge: 1,
    grantedScopes: ["PrivilegedEligibilitySchedule.Read.AzureADGroup"]
  },
  graphTargets: {
    pimGroup: {
      hasToken: true,
      isExpired: false,
      tokenAge: 1,
      grantedScopes: ["PrivilegedEligibilitySchedule.Read.AzureADGroup"]
    }
  },
  azureManagement: {
    hasToken: true,
    isExpired: false,
    tokenAge: 1
  }
};

describe("portal-driven access setup", () => {
  test("selects only portal targets that need setup", () => {
    const items = buildAccessCapabilityItems(missingTokens, {});

    expect(getAccessSetupTargets(items)).toEqual(["directoryRole", "pimGroup", "azureRole"]);
    expect(getPortalUrlsForTargets(["directoryRole", "azureRole"])).toEqual([
      ENTRA_PORTAL_URLS.directoryRole,
      ENTRA_GRAPH_BOOTSTRAP_URLS.directoryRole,
      ENTRA_PORTAL_URLS.azureRole
    ]);
  });

  test("uses successful API diagnostics over missing token scope claims", () => {
    const cache: QuickPimDataCache = {
      eligibleByTarget: {
        pimGroup: {
          items: [],
          errors: [],
          fetchedAt: Date.parse("2026-05-18T12:00:00.000Z"),
          cacheKey: buildTargetCacheKey(freshTokensWithoutVisibleScopes, "pimGroup"),
          diagnostics: [
            {
              target: "pimGroup",
              success: true,
              checkedAt: "2026-05-18T12:00:00.000Z"
            }
          ]
        }
      }
    };

    const status = buildAccessCapabilityItems(freshTokensWithoutVisibleScopes, cache);

    expect(status.find((item) => item.target === "pimGroup")).toMatchObject({
      status: "ready",
      detail: "Last API check succeeded."
    });
  });

  test("does not mark PIM groups ready when activation write scope is missing", () => {
    const cache: QuickPimDataCache = {
      eligibleByTarget: {
        pimGroup: {
          items: [
            {
              id: "pimGroup:group-1:member",
              type: "pimGroup",
              sourceName: "Ops Group",
              displayName: "Ops Group",
              principalId: "user-1",
              groupId: "group-1",
              accessId: "member",
              scopeLabel: "Group",
              status: "eligible"
            }
          ],
          errors: [],
          fetchedAt: Date.parse("2026-05-18T12:00:00.000Z"),
          cacheKey: buildTargetCacheKey(freshTokensWithPimGroupReadOnlyScope, "pimGroup"),
          diagnostics: [
            {
              target: "pimGroup",
              success: true,
              checkedAt: "2026-05-18T12:00:00.000Z"
            }
          ]
        }
      }
    };

    const status = buildAccessCapabilityItems(freshTokensWithPimGroupReadOnlyScope, cache);

    expect(status.find((item) => item.target === "pimGroup")).toMatchObject({
      status: "limited",
      detail: "Captured Graph token can read PIM Groups, but it is missing the write scope required for activation.",
      lastError: expect.stringContaining("PrivilegedAssignmentSchedule.ReadWrite.AzureADGroup")
    });
    expect(getAccessSetupTargets(status)).toContain("pimGroup");
  });

  test("does not use an unscoped legacy cache as evidence for the current identity", () => {
    const cache: QuickPimDataCache = {
      eligible: {
        items: [
          {
            id: "directoryRole:reader:/",
            type: "directoryRole",
            sourceName: "Global Reader",
            displayName: "Global Reader",
            principalId: "user-1",
            roleDefinitionId: "reader",
            directoryScopeId: "/",
            scopeLabel: "Tenant",
            status: "eligible"
          }
        ],
        errors: [],
        fetchedAt: Date.parse("2026-05-18T12:00:00.000Z")
      }
    };

    const status = buildAccessCapabilityItems(freshTokensWithoutVisibleScopes, cache);

    expect(status.find((item) => item.target === "directoryRole")).toMatchObject({
      status: "needsPortalRefresh"
    });
  });

  test("surfaces the newest permission failure while retaining cached items", () => {
    const cache: QuickPimDataCache = {
      eligibleByTarget: {
        pimGroup: {
          items: [
            {
              id: "pimGroup:group-1:member",
              type: "pimGroup",
              sourceName: "Ops Group",
              displayName: "Ops Group",
              principalId: "user-1",
              groupId: "group-1",
              accessId: "member",
              scopeLabel: "Group",
              status: "eligible"
            }
          ],
          errors: [],
          fetchedAt: Date.parse("2026-05-18T12:00:00.000Z"),
          cacheKey: buildTargetCacheKey(freshTokensWithoutVisibleScopes, "pimGroup"),
          diagnostics: [
            {
              target: "pimGroup",
              success: false,
              checkedAt: "2026-05-18T12:01:00.000Z",
              error: "Authorization failed due to missing permission scope PrivilegedAssignmentSchedule.Read.AzureADGroup"
            }
          ]
        }
      }
    };

    const status = buildAccessCapabilityItems(freshTokensWithoutVisibleScopes, cache);

    expect(status.find((item) => item.target === "pimGroup")).toMatchObject({
      status: "limited",
      detail: "Cached data is available, but the latest Microsoft API check was blocked."
    });
  });

  test("isolates feature failures instead of marking every feature limited", () => {
    const cache: QuickPimDataCache = {
      eligibleByTarget: {
        directoryRole: {
          items: [],
          errors: [],
          fetchedAt: Date.parse("2026-05-18T12:00:00.000Z"),
          cacheKey: buildTargetCacheKey(freshTokensWithoutVisibleScopes, "directoryRole"),
          diagnostics: [
            {
              target: "directoryRole",
              success: true,
              checkedAt: "2026-05-18T12:00:00.000Z"
            }
          ]
        },
        pimGroup: {
          items: [],
          errors: [],
          fetchedAt: Date.parse("2026-05-18T12:00:00.000Z"),
          cacheKey: buildTargetCacheKey(freshTokensWithoutVisibleScopes, "pimGroup"),
          diagnostics: [
            {
              target: "pimGroup",
              success: false,
              checkedAt: "2026-05-18T12:01:00.000Z",
              error: "Authorization failed due to missing permission scope PrivilegedAssignmentSchedule.Read.AzureADGroup"
            }
          ]
        }
      }
    };

    const status = buildAccessCapabilityItems(freshTokensWithoutVisibleScopes, cache);

    expect(status.find((item) => item.target === "directoryRole")).toMatchObject({ status: "ready" });
    expect(status.find((item) => item.target === "pimGroup")).toMatchObject({ status: "limited" });
    expect(status.find((item) => item.target === "azureRole")).toMatchObject({ status: "ready" });
  });

  test("ignores capability diagnostics cached for another tenant or principal", () => {
    const oldStatus: TokenStatus = {
      graph: { hasToken: true, tenantId: "tenant-a", principalId: "user-a", grantedScopes: [] },
      azureManagement: { hasToken: false }
    };
    const currentStatus: TokenStatus = {
      graph: { hasToken: true, tenantId: "tenant-b", principalId: "user-b", grantedScopes: [] },
      azureManagement: { hasToken: false }
    };
    const cache: QuickPimDataCache = {
      eligibleByTarget: {
        directoryRole: {
          items: [],
          errors: [],
          fetchedAt: Date.parse("2026-05-18T12:00:00.000Z"),
          cacheKey: buildTargetCacheKey(oldStatus, "directoryRole"),
          diagnostics: [{ target: "directoryRole", success: true, checkedAt: "2026-05-18T12:00:00.000Z" }]
        }
      }
    };

    expect(buildAccessCapabilityItems(currentStatus, cache, ["directoryRole"])[0]).toMatchObject({
      status: "needsPortalRefresh"
    });
  });

  test("builds cache keys from token capability instead of capture time", () => {
    const first = buildTokenCacheKey({
      graph: {
        hasToken: true,
        capturedAt: 1,
        expiresAt: "2026-05-18T14:00:00.000Z",
        grantedScopes: ["RoleManagement.Read.Directory", "RoleEligibilitySchedule.Read.Directory"]
      },
      azureManagement: {
        hasToken: true,
        capturedAt: 1,
        expiresAt: "2026-05-18T14:00:00.000Z"
      }
    });
    const second = buildTokenCacheKey({
      graph: {
        hasToken: true,
        capturedAt: 2,
        expiresAt: "2026-05-18T14:00:00.000Z",
        grantedScopes: ["RoleEligibilitySchedule.Read.Directory", "RoleManagement.Read.Directory"]
      },
      azureManagement: {
        hasToken: true,
        capturedAt: 2,
        expiresAt: "2026-05-18T14:00:00.000Z"
      }
    });

    expect(second).toBe(first);
  });

  test("keeps cache keys stable when a token is renewed with the same identity and scopes", () => {
    const first: TokenStatus = {
      graph: {
        hasToken: true,
        tenantId: "tenant-a",
        principalId: "user-a",
        expiresAt: "2026-05-18T14:00:00.000Z",
        grantedScopes: ["RoleEligibilitySchedule.Read.Directory"]
      },
      azureManagement: {
        hasToken: true,
        tenantId: "tenant-a",
        principalId: "user-a",
        expiresAt: "2026-05-18T14:00:00.000Z"
      }
    };
    const renewed: TokenStatus = {
      graph: {
        ...first.graph,
        capturedAt: 2,
        expiresAt: "2026-05-18T15:00:00.000Z"
      },
      azureManagement: {
        ...first.azureManagement,
        capturedAt: 2,
        expiresAt: "2026-05-18T15:00:00.000Z"
      }
    };

    expect(buildTokenCacheKey(renewed)).toBe(buildTokenCacheKey(first));
    expect(buildTargetCacheKey(renewed, "directoryRole")).toBe(buildTargetCacheKey(first, "directoryRole"));
    expect(buildTargetCacheKey(renewed, "azureRole")).toBe(buildTargetCacheKey(first, "azureRole"));
  });

  test("includes target-specific Graph tokens in cache keys", () => {
    const first = buildTokenCacheKey({
      graph: {
        hasToken: true,
        grantedScopes: ["RoleEligibilitySchedule.Read.Directory"]
      },
      graphTargets: {
        pimGroup: {
          hasToken: true,
          grantedScopes: ["PrivilegedEligibilitySchedule.Read.AzureADGroup"]
        }
      },
      azureManagement: {
        hasToken: true
      }
    });
    const second = buildTokenCacheKey({
      graph: {
        hasToken: true,
        grantedScopes: ["RoleEligibilitySchedule.Read.Directory"]
      },
      graphTargets: {
        pimGroup: {
          hasToken: true,
          grantedScopes: ["PrivilegedAssignmentSchedule.ReadWrite.AzureADGroup"]
        }
      },
      azureManagement: {
        hasToken: true
      }
    });

    expect(second).not.toBe(first);
  });

  test("builds independent target cache keys so unrelated token changes do not invalidate every feature", () => {
    const first: TokenStatus = {
      graph: {
        hasToken: true,
        expiresAt: "2026-05-18T14:00:00.000Z",
        grantedScopes: ["RoleEligibilitySchedule.Read.Directory"]
      },
      graphTargets: {
        directoryRole: {
          hasToken: true,
          expiresAt: "2026-05-18T14:00:00.000Z",
          grantedScopes: ["RoleEligibilitySchedule.Read.Directory"]
        },
        pimGroup: {
          hasToken: true,
          expiresAt: "2026-05-18T14:00:00.000Z",
          grantedScopes: ["PrivilegedEligibilitySchedule.Read.AzureADGroup"]
        }
      },
      azureManagement: {
        hasToken: true,
        expiresAt: "2026-05-18T14:00:00.000Z"
      }
    };
    const second: TokenStatus = {
      ...first,
      graphTargets: {
        ...first.graphTargets,
        pimGroup: {
          hasToken: true,
          expiresAt: "2026-05-18T15:00:00.000Z",
          grantedScopes: ["PrivilegedAssignmentSchedule.ReadWrite.AzureADGroup"]
        }
      }
    };

    expect(buildTargetCacheKey(second, "directoryRole")).toBe(buildTargetCacheKey(first, "directoryRole"));
    expect(buildTargetCacheKey(second, "azureRole")).toBe(buildTargetCacheKey(first, "azureRole"));
    expect(buildTargetCacheKey(second, "pimGroup")).not.toBe(buildTargetCacheKey(first, "pimGroup"));
  });

  test("isolates cached role data by tenant and principal", () => {
    const first: TokenStatus = {
      graph: { hasToken: true, tenantId: "tenant-a", principalId: "user-a" },
      azureManagement: { hasToken: false }
    };
    const second: TokenStatus = {
      graph: { hasToken: true, tenantId: "tenant-b", principalId: "user-a" },
      azureManagement: { hasToken: false }
    };
    expect(buildTargetCacheKey(first, "directoryRole")).not.toBe(buildTargetCacheKey(second, "directoryRole"));
  });
});
