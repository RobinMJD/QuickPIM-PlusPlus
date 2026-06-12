import { describe, expect, test } from "vitest";
import {
  DEFAULT_ACTIVE_CACHE_TTL_MS,
  DEFAULT_ELIGIBLE_CACHE_TTL_MS,
  STALE_ELIGIBLE_CACHE_TTL_MS,
  formatCacheAge,
  getActivationDataWithCache,
  getDataWithCache,
  getTargetCacheStatus,
  getTargetEntriesFromCache,
  isCacheEntryFresh
} from "../src/lib/cache";
import {
  ENTRA_PORTAL_URLS,
  formatActivationStatusLabel,
  formatLoadMessages,
  getActivationStatusTitle,
  getActivationRequirements,
  coerceDurationForItems,
  getDurationOptions,
  getRemainingSelectedIdsAfterActivationResults,
  getPortalUrlForTab,
  getActivatableItems,
  getDeactivatableItems,
  getActiveStatusTitle,
  isHighPrivilegeItem,
  mergeEligibleWithActive,
  tokenStatusText
} from "../src/lib/popupModel";
import { buildDirectoryRoleDefinitionNameMap, normalizeDirectoryRole } from "../src/lib/pim";
import { isPrivilegedAzureRoleDefinition } from "../src/lib/privilegedRoles";
import { makeTokenStatus } from "../src/lib/token";
import type { ActivationItem } from "../src/lib/types";

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

const azureRole: ActivationItem = {
  id: "azureRole:contributor:/subscriptions/sub-1",
  type: "azureRole",
  sourceName: "Contributor",
  displayName: "Contributor",
  principalId: "user-1",
  roleDefinitionId: "contributor",
  scope: "/subscriptions/sub-1",
  scopeLabel: "Production",
  status: "eligible"
};

describe("popup cache helpers", () => {
  test("uses separate freshness windows for eligible and active data", () => {
    const now = Date.parse("2026-05-18T12:00:00.000Z");

    expect(
      isCacheEntryFresh({ items: [directoryRole], errors: [], fetchedAt: now - DEFAULT_ELIGIBLE_CACHE_TTL_MS + 1 }, DEFAULT_ELIGIBLE_CACHE_TTL_MS, now)
    ).toBe(true);
    expect(
      isCacheEntryFresh({ items: [directoryRole], errors: [], fetchedAt: now - DEFAULT_ELIGIBLE_CACHE_TTL_MS - 1 }, DEFAULT_ELIGIBLE_CACHE_TTL_MS, now)
    ).toBe(false);
    expect(
      isCacheEntryFresh({ items: [], errors: [], fetchedAt: now - DEFAULT_ACTIVE_CACHE_TTL_MS - 1 }, DEFAULT_ACTIVE_CACHE_TTL_MS, now)
    ).toBe(false);
    expect(DEFAULT_ACTIVE_CACHE_TTL_MS).toBeGreaterThanOrEqual(10 * 60 * 1000);
  });

  test("formats cache age in minutes for status copy", () => {
    const now = Date.parse("2026-05-18T12:10:00.000Z");
    expect(formatCacheAge(Date.parse("2026-05-18T12:09:20.000Z"), now)).toBe("less than 1 min ago");
    expect(formatCacheAge(Date.parse("2026-05-18T12:02:00.000Z"), now)).toBe("8 min ago");
  });

  test("does not replay stale errors when serving fresh cached data", async () => {
    const now = Date.parse("2026-05-18T12:10:00.000Z");
    const cached = {
      items: [directoryRole],
      errors: ["The access token expiry UTC time '5/18/2026 2:22:14 PM' is earlier than current UTC time."],
      fetchedAt: now - 60_000
    };

    const result = await getDataWithCache(
      "eligible",
      { eligible: cached },
      DEFAULT_ELIGIBLE_CACHE_TTL_MS,
      false,
      async () => {
        throw new Error("Should not fetch while cache is fresh");
      },
      now
    );

    expect(result.fromCache).toBe(true);
    expect(result.entry.errors).toEqual([]);
  });

  test("invalidates cached data when the captured token context changes", async () => {
    const now = Date.parse("2026-05-18T12:10:00.000Z");
    const cached = {
      items: [directoryRole],
      errors: [],
      fetchedAt: now - 60_000,
      cacheKey: "graph:old|azure:old"
    };

    const result = await getDataWithCache(
      "eligible",
      { eligible: cached },
      DEFAULT_ELIGIBLE_CACHE_TTL_MS,
      false,
      async () => ({ items: [azureRole], errors: [] }),
      now,
      "graph:new|azure:old"
    );

    expect(result.fromCache).toBe(false);
    expect(result.entry.items).toEqual([azureRole]);
    expect(result.entry.cacheKey).toBe("graph:new|azure:old");
  });

  test("refreshes eligible and active cache entries without serializing both API calls", async () => {
    const now = Date.parse("2026-05-18T12:10:00.000Z");
    const started: string[] = [];
    let releaseEligible: (() => void) | undefined;
    let activeStartedBeforeEligibleResolved = false;

    const resultPromise = getActivationDataWithCache({
      cache: {},
      force: true,
      now,
      tokenCacheKey: "graph:new|azure:new",
      fetchEligible: async () => {
        started.push("eligible");
        await new Promise<void>((resolve) => {
          releaseEligible = resolve;
        });
        return { items: [directoryRole], errors: [] };
      },
      fetchActive: async () => {
        started.push("active");
        activeStartedBeforeEligibleResolved = Boolean(releaseEligible);
        releaseEligible?.();
        return { items: [{ ...azureRole, status: "active" }], errors: [] };
      }
    });

    const result = await resultPromise;

    expect(started).toEqual(["eligible", "active"]);
    expect(activeStartedBeforeEligibleResolved).toBe(true);
    expect(result.eligible.entry.items).toEqual([directoryRole]);
    expect(result.active.entry.items).toEqual([{ ...azureRole, status: "active" }]);
    expect(result.cache.eligible?.cacheKey).toBe("graph:new|azure:new");
    expect(result.cache.active?.cacheKey).toBe("graph:new|azure:new");
  });

  test("uses stale eligible target cache for display while marking it refreshable", () => {
    const now = Date.parse("2026-05-18T12:45:00.000Z");
    const status = getTargetCacheStatus({
      cache: {
        eligibleByTarget: {
          directoryRole: {
            items: [directoryRole],
            errors: ["old transient error"],
            fetchedAt: now - DEFAULT_ELIGIBLE_CACHE_TTL_MS - 1,
            cacheKey: "graph:directory"
          }
        }
      },
      bucket: "eligible",
      target: "directoryRole",
      cacheKey: "graph:directory",
      now,
      freshTtlMs: DEFAULT_ELIGIBLE_CACHE_TTL_MS,
      usableTtlMs: STALE_ELIGIBLE_CACHE_TTL_MS
    });

    expect(status.isUsable).toBe(true);
    expect(status.isFresh).toBe(false);
    expect(status.entry?.items).toEqual([directoryRole]);
    expect(status.entry?.errors).toEqual([]);
  });

  test("does not reuse active target cache past the active freshness window", () => {
    const now = Date.parse("2026-05-18T12:45:00.000Z");
    const status = getTargetCacheStatus({
      cache: {
        activeByTarget: {
          directoryRole: {
            items: [{ ...directoryRole, status: "active" }],
            errors: [],
            fetchedAt: now - DEFAULT_ACTIVE_CACHE_TTL_MS - 1,
            cacheKey: "graph:directory"
          }
        }
      },
      bucket: "active",
      target: "directoryRole",
      cacheKey: "graph:directory",
      now,
      freshTtlMs: DEFAULT_ACTIVE_CACHE_TTL_MS
    });

    expect(status.isUsable).toBe(false);
    expect(status.entry).toBeUndefined();
  });

  test("can seed per-target display from a legacy aggregate cache", () => {
    const now = Date.parse("2026-05-18T12:05:00.000Z");
    const entries = getTargetEntriesFromCache(
      {
        eligible: {
          items: [directoryRole, azureRole],
          errors: [],
          fetchedAt: now - 60_000,
          cacheKey: "legacy:key",
          diagnostics: [
            { target: "directoryRole", success: true, checkedAt: "2026-05-18T12:04:00.000Z" },
            { target: "azureRole", success: true, checkedAt: "2026-05-18T12:04:00.000Z" }
          ]
        }
      },
      "eligible",
      ["directoryRole", "azureRole"],
      {
        directoryRole: "graph:directory",
        azureRole: "azure"
      },
      {
        legacyCacheKey: "legacy:key",
        now,
        freshTtlMs: DEFAULT_ELIGIBLE_CACHE_TTL_MS,
        usableTtlMs: STALE_ELIGIBLE_CACHE_TTL_MS
      }
    );

    expect(entries.directoryRole?.entry?.items).toEqual([directoryRole]);
    expect(entries.azureRole?.entry?.items).toEqual([azureRole]);
    expect(entries.directoryRole?.entry?.diagnostics).toEqual([
      { target: "directoryRole", success: true, checkedAt: "2026-05-18T12:04:00.000Z", fromCache: true }
    ]);
  });
});

describe("popup model helpers", () => {
  test("shows readable token status instead of raw minute badges", () => {
    expect(tokenStatusText("Graph", { hasToken: true, tokenAge: 1, isExpired: false })).toBe("Graph ready (1 min ago)");
    expect(tokenStatusText("Azure", { hasToken: false })).toBe("Azure token missing");
  });

  test("uses JWT expiry instead of capture age for token status", () => {
    const now = Date.parse("2026-05-18T14:23:42.000Z");
    const capturedAt = now - 4 * 60_000;
    const expiredToken = makeToken({ exp: Math.floor((now - 60_000) / 1000), oid: "user-1" });
    const freshToken = makeToken({ exp: Math.floor((now + 10 * 60_000) / 1000), oid: "user-1" });

    expect(makeTokenStatus(expiredToken, capturedAt, "portal", now)).toMatchObject({
      hasToken: true,
      tokenAge: 4,
      isExpired: true
    });
    expect(makeTokenStatus(freshToken, capturedAt, "portal", now)).toMatchObject({
      hasToken: true,
      tokenAge: 4,
      isExpired: false,
      expiresInMinutes: 10
    });
    expect(tokenStatusText("Graph", makeTokenStatus(expiredToken, capturedAt, "portal", now))).toBe(
      "Graph expired. Refresh in portal."
    );
  });

  test("maps role tabs to matching Entra portal pages", () => {
    expect(getPortalUrlForTab("directoryRole")).toBe(ENTRA_PORTAL_URLS.directoryRole);
    expect(getPortalUrlForTab("pimGroup")).toBe(ENTRA_PORTAL_URLS.pimGroup);
    expect(getPortalUrlForTab("azureRole")).toBe(ENTRA_PORTAL_URLS.azureRole);
  });

  test("overlays active and pending approval state only onto matching eligible items", () => {
    const activeDirectoryRole: ActivationItem = {
      ...directoryRole,
      status: "active",
      activeUntil: "2026-05-18T14:00:00.000Z"
    };
    const pendingDirectoryRole: ActivationItem = {
      ...directoryRole,
      status: "pendingApproval",
      activationRequirements: {
        approval: true
      }
    };
    const activeOnlyRole: ActivationItem = {
      ...azureRole,
      status: "active",
      activeUntil: "2026-05-18T15:00:00.000Z"
    };

    expect(mergeEligibleWithActive([directoryRole], [activeDirectoryRole, activeOnlyRole])).toEqual([
      {
        ...directoryRole,
        status: "active",
        activeUntil: "2026-05-18T14:00:00.000Z"
      }
    ]);
    expect(mergeEligibleWithActive([directoryRole], [pendingDirectoryRole])).toEqual([
      {
        ...directoryRole,
        status: "pendingApproval",
        activationRequirements: {
          approval: true
        }
      }
    ]);
    expect(mergeEligibleWithActive([directoryRole], [pendingDirectoryRole, activeDirectoryRole])[0]).toMatchObject({
      status: "active"
    });
  });

  test("filters active and pending approval items out of activatable selections", () => {
    expect(getActivatableItems([directoryRole, { ...azureRole, status: "active" }, { ...directoryRole, status: "pendingApproval" }])).toEqual([directoryRole]);
  });

  test("can include active-only items for deactivation display", () => {
    const activeOnlyRole: ActivationItem = {
      ...azureRole,
      status: "active",
      activeUntil: "2026-05-18T15:00:00.000Z",
      assignmentScheduleId: "schedule-1"
    };

    expect(mergeEligibleWithActive([directoryRole], [activeOnlyRole], { includeActiveOnly: true })).toEqual([
      directoryRole,
      activeOnlyRole
    ]);
    expect(getDeactivatableItems([directoryRole, activeOnlyRole, { ...directoryRole, status: "pendingApproval" }])).toEqual([activeOnlyRole]);
  });

  test("identifies high privilege rows from Microsoft-provided role metadata", () => {
    expect(isHighPrivilegeItem({ ...directoryRole, displayName: "Global Administrator", isPrivileged: true })).toBe(true);
    expect(isHighPrivilegeItem({ ...directoryRole, displayName: "Global Administrator" })).toBe(false);
    expect(isHighPrivilegeItem({ ...azureRole, displayName: "Owner", isPrivileged: true })).toBe(true);
    expect(isHighPrivilegeItem({ ...azureRole, displayName: "Reader" })).toBe(false);
  });

  test("uses Microsoft Azure privileged administrator role-definition actions", () => {
    expect(
      isPrivilegedAzureRoleDefinition({
        properties: {
          permissions: [
            {
              actions: ["Microsoft.Authorization/roleAssignments/write"]
            }
          ]
        }
      })
    ).toBe(true);
    expect(
      isPrivilegedAzureRoleDefinition({
        properties: {
          permissions: [
            {
              actions: ["Microsoft.Resources/subscriptions/resourceGroups/read"]
            }
          ]
        }
      })
    ).toBe(false);
  });

  test("formats active status hover text when an end time is known", () => {
    expect(
      getActiveStatusTitle(
        { ...directoryRole, status: "active", activeUntil: "2026-05-18T14:00:00.000Z" },
        Date.parse("2026-05-18T12:30:00.000Z")
      )
    ).toBe("Active until 2026-05-18 14:00 (about 1 hour 30 minutes remaining)");
    expect(getActiveStatusTitle({ ...directoryRole, status: "active" })).toBeUndefined();
    expect(getActivationStatusTitle({ ...directoryRole, status: "pendingApproval", activationRequirements: { approval: true } })).toBe(
      "Activation request is waiting for approval."
    );
    expect(formatActivationStatusLabel("pendingApproval")).toBe("Pending approval");
  });

  test("only requests activation metadata fields required by selected items", () => {
    expect(getActivationRequirements([])).toEqual({
      needsJustification: false,
      needsTicket: false
    });
    expect(getActivationRequirements([directoryRole, azureRole])).toEqual({
      needsJustification: true,
      needsTicket: false
    });
    expect(getActivationRequirements([{ ...directoryRole, activationRequirements: { justification: true, ticket: true } }])).toEqual({
      needsJustification: true,
      needsTicket: true
    });
  });

  test("formats raw Graph permission JSON into readable warnings", () => {
    const warning = formatLoadMessages([
      '{"errorCode":"PermissionScopeNotGranted","message":"Authorization failed due to missing permission scope PrivilegedAssignmentSchedule.Read.AzureADGroup,PrivilegedAssignmentSchedule.ReadWrite.AzureADGroup","localizedMessage":"[]"}',
      "Using cached data from 2 min ago."
    ]);

    expect(warning).toEqual([
      "PIM Groups access is limited in the captured portal token. Use Access Setup to refresh portal access.",
      "Using cached data from 2 min ago."
    ]);
  });

  test("formats Graph claims challenges into a retry action", () => {
    const claims = encodeURIComponent(JSON.stringify({ access_token: { acrs: { essential: true, value: "c1" } } }));

    expect(formatLoadMessages([`&claims=${claims}`])).toEqual([
      "Microsoft requires an additional sign-in or MFA challenge before this activation can continue. Open the matching Microsoft portal page, complete the prompt, then retry."
    ]);
  });

  test("keeps failed activation items selected after a partial activation", () => {
    const remaining = getRemainingSelectedIdsAfterActivationResults(["directoryRole:admin:/", "pimGroup:group-1:member"], [
      { itemId: "pimGroup:group-1:member", itemName: "Privileged group", success: true },
      { itemId: "directoryRole:admin:/", itemName: "User Administrator", success: false, error: "Claims challenge" }
    ]);

    expect([...remaining]).toEqual(["directoryRole:admin:/"]);
  });

  test("formats token expiry API errors into a short action", () => {
    expect(
      formatLoadMessages([
        "The access token expiry UTC time '5/18/2026 2:22:14 PM' is earlier than current UTC time '5/18/2026 2:23:42 PM'."
      ])
    ).toEqual(["Captured token expired. Refresh in portal."]);
  });

  test("uses expanded directory role names before falling back to role definition ids", () => {
    expect(
      normalizeDirectoryRole({
        roleDefinitionId: "968ca2cf-d644-4258-8311-65ba3a692b96",
        principalId: "user-1",
        roleDefinition: {
          displayName: "Agent ID Administrator"
        }
      }).displayName
    ).toBe("Agent ID Administrator");
  });

  test("maps directory role definitions by template id as well as definition id", () => {
    expect(
      buildDirectoryRoleDefinitionNameMap([
        {
          id: "definition-id",
          templateId: "968ca2cf-d644-4258-8311-65ba3a692b96",
          displayName: "Agent ID Administrator"
        }
      ])
    ).toMatchObject({
      "definition-id": "Agent ID Administrator",
      "968ca2cf-d644-4258-8311-65ba3a692b96": "Agent ID Administrator"
    });
  });

  test("uses duration labels instead of localized fractional numeric text", () => {
    expect(getDurationOptions([directoryRole])[0]).toEqual({ value: 0.5, label: "30 minutes" });
    expect(getDurationOptions([directoryRole]).find((option) => option.value === 1)?.label).toBe("1 hour");
    expect(getDurationOptions([directoryRole]).find((option) => option.value === 2)?.label).toBe("2 hours");
  });

  test("hides duration choices until at least one item is selected", () => {
    expect(getDurationOptions([])).toEqual([]);
  });

  test("caps duration choices to the strictest selected item maximum", () => {
    const cappedDirectoryRole: ActivationItem = {
      ...directoryRole,
      activationRequirements: {
        justification: true,
        ticket: false,
        maxDurationHours: 4
      }
    };
    const cappedAzureRole: ActivationItem = {
      ...azureRole,
      activationRequirements: {
        justification: true,
        ticket: false,
        maxDurationHours: 8
      }
    };

    expect(getDurationOptions([cappedDirectoryRole, cappedAzureRole]).map((option) => option.value)).toEqual([0.5, 1, 2, 4]);
    expect(coerceDurationForItems(8, [cappedDirectoryRole, cappedAzureRole])).toBe(4);
    expect(coerceDurationForItems(1, [cappedDirectoryRole, cappedAzureRole])).toBe(1);
  });

  test("duration choices ignore already active selected items", () => {
    const activeCappedRole: ActivationItem = {
      ...directoryRole,
      status: "active",
      activationRequirements: {
        justification: true,
        ticket: false,
        maxDurationHours: 1
      }
    };
    const eligibleCappedRole: ActivationItem = {
      ...azureRole,
      activationRequirements: {
        justification: true,
        ticket: false,
        maxDurationHours: 4
      }
    };

    expect(getDurationOptions([activeCappedRole, eligibleCappedRole]).map((option) => option.value)).toEqual([0.5, 1, 2, 4]);
  });

  test("includes exact nonstandard maximum duration as a selectable value", () => {
    const cappedRole: ActivationItem = {
      ...directoryRole,
      activationRequirements: {
        justification: true,
        ticket: false,
        maxDurationHours: 3
      }
    };

    expect(getDurationOptions([cappedRole]).map((option) => option.value)).toEqual([0.5, 1, 2, 3]);
  });
});

function makeToken(payload: Record<string, unknown>): string {
  const encodedPayload = btoa(JSON.stringify(payload)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  return `header.${encodedPayload}.signature`;
}
