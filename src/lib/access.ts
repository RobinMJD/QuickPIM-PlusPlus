import { ENTRA_GRAPH_BOOTSTRAP_URLS, ENTRA_PORTAL_URLS } from "./popupModel";
import {
  getMatchedGraphActivationScope,
  getRequiredGraphActivationScopes,
  type GraphTokenTarget
} from "./graphTokenCapabilities";
import type {
  AccessCapabilityStatus,
  AccessDiagnostic,
  AccessDiagnosticOperation,
  AccessFailureKind,
  AccessSetupTarget,
  QuickPimDataCache,
  TokenStatus,
  TokenStatusEntry
} from "./types";

export interface AccessCapabilityItem {
  target: AccessSetupTarget;
  label: string;
  status: AccessCapabilityStatus;
  detail: string;
  lastSuccessAt?: string;
  lastSuccessOperation?: AccessDiagnosticOperation;
  lastFailureAt?: string;
  lastFailureOperation?: AccessDiagnosticOperation;
  lastFailureEndpoint?: string;
  failureKind?: AccessFailureKind;
  lastError?: string;
  recommendedAction?: string;
}

const TARGET_LABELS: Record<AccessSetupTarget, string> = {
  directoryRole: "Entra Roles",
  pimGroup: "PIM Groups",
  azureRole: "Azure Roles"
};

const TARGET_READ_SCOPES: Record<AccessSetupTarget, string[]> = {
  directoryRole: [
    "RoleEligibilitySchedule.Read.Directory",
    "RoleEligibilitySchedule.ReadWrite.Directory",
    "RoleManagement.Read.All",
    "RoleManagement.Read.Directory",
    "RoleManagement.ReadWrite.Directory"
  ],
  pimGroup: [
    "PrivilegedEligibilitySchedule.Read.AzureADGroup",
    "PrivilegedEligibilitySchedule.ReadWrite.AzureADGroup",
    "PrivilegedAccess.Read.AzureADGroup",
    "PrivilegedAccess.ReadWrite.AzureADGroup"
  ],
  azureRole: []
};

export function buildAccessCapabilityItems(
  tokenStatus: TokenStatus | null | undefined,
  cache: QuickPimDataCache | undefined,
  targets: AccessSetupTarget[] = ["directoryRole", "pimGroup", "azureRole"]
): AccessCapabilityItem[] {
  return targets.map((target) => {
    const entries = getCurrentTargetEntries(cache, tokenStatus, target);
    const diagnostics = entries.flatMap((entry) => entry.diagnostics || []).filter((item) => item.target === target);
    const hasLoadedItems = entries.some((entry) => entry.items.some((item) => item.type === target));
    return buildAccessCapabilityItem(target, tokenStatus, diagnostics, hasLoadedItems);
  });
}

export function getAccessSetupTargets(items: AccessCapabilityItem[]): AccessSetupTarget[] {
  return items.filter((item) => item.status !== "ready").map((item) => item.target);
}

export function getPortalUrlsForTargets(targets: AccessSetupTarget[]): string[] {
  return [
    ...new Set(
      targets.flatMap((target) => {
        if (target === "directoryRole" || target === "pimGroup") {
          return [ENTRA_PORTAL_URLS[target], ENTRA_GRAPH_BOOTSTRAP_URLS[target]];
        }
        return [ENTRA_PORTAL_URLS[target]];
      })
    )
  ];
}

export function classifyAccessFailure(error: string | undefined): AccessFailureKind {
  const text = (error || "").toLowerCase();
  if (!text) {
    return "unknown";
  }
  if (text.includes("token is missing")) {
    return "missingToken";
  }
  if (text.includes("expired") || text.includes("expiry utc time")) {
    return "expiredToken";
  }
  if (text.includes("missing permission") || text.includes("permissionscopenotgranted") || text.includes("missing activation scope") || text.includes("limited in the captured portal token")) {
    return "missingCapability";
  }
  if (text.includes("mfa challenge") || text.includes("additional sign-in") || text.includes("claims")) {
    return "claimsChallenge";
  }
  if (text.includes("forbidden") || text.includes(" 403") || text === "403") {
    return "forbidden";
  }
  if (text.includes("failed to fetch") || text.includes("network")) {
    return "network";
  }
  return "unknown";
}

export function summarizeAccessDiagnostics(diagnostics: AccessDiagnostic[]): {
  lastSuccess?: AccessDiagnostic;
  lastFailure?: AccessDiagnostic;
} {
  const sorted = [...diagnostics].sort((a, b) => b.checkedAt.localeCompare(a.checkedAt));
  return {
    lastSuccess: sorted.find((item) => item.success),
    lastFailure: sorted.find((item) => !item.success)
  };
}

export function buildTokenCacheKey(tokenStatus: TokenStatus | null | undefined): string {
  const parts = [buildTokenCachePart("graph", tokenStatus?.graph)];
  if (tokenStatus?.graphTargets) {
    parts.push(
      buildTokenCachePart("graphDirectory", tokenStatus.graphTargets.directoryRole),
      buildTokenCachePart("graphPimGroup", tokenStatus.graphTargets.pimGroup)
    );
  }
  parts.push(buildTokenCachePart("azure", tokenStatus?.azureManagement));
  return parts.join("|");
}

export function buildTargetCacheKey(tokenStatus: TokenStatus | null | undefined, target: AccessSetupTarget): string {
  if (target === "azureRole") {
    return buildTokenCachePart("azure", tokenStatus?.azureManagement);
  }
  const graphToken = tokenStatus?.graphTargets?.[target] || tokenStatus?.graph;
  return buildTokenCachePart(target === "directoryRole" ? "graphDirectory" : "graphPimGroup", graphToken);
}

export function buildTargetCacheKeys(
  tokenStatus: TokenStatus | null | undefined,
  targets: AccessSetupTarget[]
): Partial<Record<AccessSetupTarget, string>> {
  return Object.fromEntries(targets.map((target) => [target, buildTargetCacheKey(tokenStatus, target)]));
}

export function hasRequiredPortalToken(target: AccessSetupTarget, tokenStatus: TokenStatus): boolean {
  const token = getTokenStatusForTarget(target, tokenStatus);
  if (!token?.hasToken || token.isExpired) {
    return false;
  }

  if (target === "azureRole") {
    return true;
  }

  return !hasKnownScopes(token) || Boolean(getMatchedGraphActivationScope(target, new Set(token.grantedScopes || [])));
}

function buildTokenCachePart(label: string, token: TokenStatusEntry | undefined): string {
  if (!token?.hasToken || token.isExpired) {
    return `${label}:missing`;
  }

  const scopes = [...(token.grantedScopes || [])].sort((a, b) => a.localeCompare(b)).join(",");
  const identity = token.tenantId && token.principalId ? `${token.tenantId}:${token.principalId}:` : "";
  return `${label}:${identity}${token.expiresAt || ""}:${scopes}`;
}

function buildAccessCapabilityItem(
  target: AccessSetupTarget,
  tokenStatus: TokenStatus | null | undefined,
  diagnostics: AccessDiagnostic[],
  hasLoadedItems: boolean
): AccessCapabilityItem {
  const token = getTokenStatusForTarget(target, tokenStatus);
  const summary = summarizeAccessDiagnostics(diagnostics);
  const latestDiagnostic = [...diagnostics].sort((a, b) => b.checkedAt.localeCompare(a.checkedAt))[0];
  const latestSuccess = summary.lastSuccess;
  const diagnosticMetadata = getCapabilityDiagnosticMetadata(target, summary);

  if (!token?.hasToken || token.isExpired) {
    return {
      target,
      label: TARGET_LABELS[target],
      status: "needsPortalRefresh",
      detail: token?.isExpired ? "Captured token expired. Open the portal to refresh it." : "Open the portal so QuickPIM++ can capture a token.",
      ...diagnosticMetadata
    };
  }

  const missingActivationScopeDetail = getMissingActivationScopeDetail(target, token);
  if (missingActivationScopeDetail) {
    return {
      target,
      label: TARGET_LABELS[target],
      status: "limited",
      detail: missingActivationScopeDetail.detail,
      lastError: missingActivationScopeDetail.lastError,
      recommendedAction: getRecommendedAction(target, "missingCapability"),
      ...diagnosticMetadata
    };
  }

  if (latestDiagnostic && !latestDiagnostic.success && isPermissionOrAuthFailure(latestDiagnostic.error)) {
    return {
      target,
      label: TARGET_LABELS[target],
      status: "limited",
      detail: hasLoadedItems
        ? "Cached data is available, but the latest Microsoft API check was blocked."
        : "The portal token was captured, but this feature is still blocked by Microsoft API access.",
      lastError: latestDiagnostic.error,
      recommendedAction: getRecommendedAction(target, latestDiagnostic.failureKind || classifyAccessFailure(latestDiagnostic.error)),
      ...diagnosticMetadata
    };
  }

  if (latestSuccess) {
    return {
      target,
      label: TARGET_LABELS[target],
      status: "ready",
      detail: "Last API check succeeded.",
      lastSuccessAt: latestSuccess.checkedAt,
      ...diagnosticMetadata
    };
  }

  if (hasLoadedItems) {
    return {
      target,
      label: TARGET_LABELS[target],
      status: "ready",
      detail: "Loaded eligible or active items.",
      ...diagnosticMetadata
    };
  }

  if (target === "azureRole") {
    return {
      target,
      label: TARGET_LABELS[target],
      status: "ready",
      detail: "Azure Management token captured.",
      ...diagnosticMetadata
    };
  }

  const grantedScopes = new Set(token.grantedScopes || []);
  const matchedScope = TARGET_READ_SCOPES[target].find((scope) => grantedScopes.has(scope));
  if (matchedScope) {
    return {
      target,
      label: TARGET_LABELS[target],
      status: "ready",
      detail: `Token includes ${matchedScope}.`,
      ...diagnosticMetadata
    };
  }

  return {
    target,
    label: TARGET_LABELS[target],
    status: "needsPortalRefresh",
    detail: "Open the matching portal page so Microsoft can request the needed access.",
    ...diagnosticMetadata
  };
}

function getCapabilityDiagnosticMetadata(
  target: AccessSetupTarget,
  summary: ReturnType<typeof summarizeAccessDiagnostics>
): Pick<AccessCapabilityItem, "lastSuccessAt" | "lastSuccessOperation" | "lastFailureAt" | "lastFailureOperation" | "lastFailureEndpoint" | "failureKind" | "recommendedAction" | "lastError"> {
  const failureKind = summary.lastFailure?.failureKind || classifyAccessFailure(summary.lastFailure?.error);
  return {
    ...(summary.lastSuccess ? {
      lastSuccessAt: summary.lastSuccess.checkedAt,
      lastSuccessOperation: summary.lastSuccess.operation
    } : {}),
    ...(summary.lastFailure ? {
      lastFailureAt: summary.lastFailure.checkedAt,
      lastFailureOperation: summary.lastFailure.operation,
      lastFailureEndpoint: summary.lastFailure.endpointLabel,
      failureKind,
      lastError: summary.lastFailure.error,
      recommendedAction: getRecommendedAction(target, failureKind)
    } : {})
  };
}

function getRecommendedAction(target: AccessSetupTarget, failureKind: AccessFailureKind): string {
  if (failureKind === "claimsChallenge") {
    return "Open the matching Microsoft portal page, complete the prompt, then retry.";
  }
  if (failureKind === "missingToken" || failureKind === "expiredToken") {
    return "Open the matching portal page so QuickPIM++ can capture a fresh token.";
  }
  if (target === "pimGroup") {
    return "Reload the PIM Groups portal page, then recheck access.";
  }
  if (target === "directoryRole") {
    return "Reload the Entra Roles portal page, then recheck access.";
  }
  return "Reload the Azure Roles portal page, then recheck access.";
}

function getTokenStatusForTarget(
  target: AccessSetupTarget,
  tokenStatus: TokenStatus | null | undefined
): TokenStatusEntry | undefined {
  if (target === "azureRole") {
    return tokenStatus?.azureManagement;
  }
  return tokenStatus?.graphTargets?.[target] || tokenStatus?.graph;
}

function getMissingActivationScopeDetail(
  target: AccessSetupTarget,
  token: TokenStatusEntry
): { detail: string; lastError: string } | undefined {
  if (target === "azureRole" || !hasKnownScopes(token)) {
    return undefined;
  }

  const graphTarget = target as GraphTokenTarget;
  const grantedScopes = new Set(token.grantedScopes || []);
  if (getMatchedGraphActivationScope(graphTarget, grantedScopes)) {
    return undefined;
  }

  const requiredScopes = getRequiredGraphActivationScopes(graphTarget).join(" or ");
  return {
    detail: `Captured Graph token can read ${TARGET_LABELS[target]}, but it is missing the write scope required for activation.`,
    lastError: `Missing activation scope: ${requiredScopes}. Open Access Setup and reload the matching Microsoft portal page.`
  };
}

function hasKnownScopes(token: TokenStatusEntry): boolean {
  return Boolean(token.grantedScopes?.length);
}

function getCurrentTargetEntries(
  cache: QuickPimDataCache | undefined,
  tokenStatus: TokenStatus | null | undefined,
  target: AccessSetupTarget
) {
  const expectedCacheKey = buildTargetCacheKey(tokenStatus, target);
  return [cache?.eligibleByTarget?.[target], cache?.activeByTarget?.[target]].filter(
    (entry): entry is NonNullable<typeof entry> => Boolean(entry && entry.cacheKey === expectedCacheKey)
  );
}

function isPermissionOrAuthFailure(error: string | undefined): boolean {
  if (!error) {
    return false;
  }

  return /403|forbidden|authorization failed|permissionscope|missing permission|does not have authorization/i.test(error);
}
