import { ENTRA_PORTAL_URLS } from "./popupModel";
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
  ActivationItem,
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
  return [...new Set(targets.map((target) => ENTRA_PORTAL_URLS[target]))];
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
  if (text.includes("failed to fetch") || text.includes("network") || text.includes("timed out")) {
    return "network";
  }
  return "unknown";
}

export function buildNameLookupDiagnostic(
  target: AccessSetupTarget,
  items: ActivationItem[],
  sourceOperation: "eligible" | "active",
  checkedAt = new Date().toISOString()
): AccessDiagnostic | undefined {
  const targetItems = items.filter((item) => item.type === target);
  if (!targetItems.length) {
    return undefined;
  }

  const unresolvedNames = targetItems.filter(hasUnresolvedItemName).length;
  const unresolvedScopes = targetItems.filter(hasUnresolvedScopeName).length;
  const unresolvedItems = targetItems.filter((item) => hasUnresolvedItemName(item) || hasUnresolvedScopeName(item)).length;
  const endpointLabel = `${sourceOperation === "eligible" ? "Eligible" : "Active"} ${TARGET_LABELS[target]} display names`;

  if (!unresolvedItems) {
    return {
      target,
      success: true,
      checkedAt,
      operation: "nameLookup",
      endpointLabel
    };
  }

  const details = [
    unresolvedNames ? `${unresolvedNames} role or group name${unresolvedNames === 1 ? "" : "s"}` : "",
    unresolvedScopes ? `${unresolvedScopes} scope name${unresolvedScopes === 1 ? "" : "s"}` : ""
  ].filter(Boolean).join(" and ");
  return {
    target,
    success: false,
    checkedAt,
    operation: "nameLookup",
    endpointLabel,
    failureKind: "unknown",
    error: `${details} could not be resolved for ${unresolvedItems} of ${targetItems.length} item${targetItems.length === 1 ? "" : "s"}. Raw identifiers remain available.`
  };
}

export function summarizeAccessDiagnostics(diagnostics: AccessDiagnostic[]): {
  lastSuccess?: AccessDiagnostic;
  lastFailure?: AccessDiagnostic;
} {
  const maximum = Date.now() + 5 * 60_000;
  const sorted = diagnostics
    .filter((item) => {
      const checkedAt = Date.parse(item.checkedAt);
      return Number.isFinite(checkedAt) && checkedAt <= maximum;
    })
    .sort((a, b) => b.checkedAt.localeCompare(a.checkedAt));
  const latestSuccessByOperation = new Map<string, AccessDiagnostic>();
  for (const diagnostic of sorted) {
    if (diagnostic.success && !latestSuccessByOperation.has(diagnosticOperationKey(diagnostic))) {
      latestSuccessByOperation.set(diagnosticOperationKey(diagnostic), diagnostic);
    }
  }
  return {
    lastSuccess: sorted.find((item) => item.success),
    lastFailure: sorted.find((item) => {
      if (item.success) return false;
      const recoveredAt = latestSuccessByOperation.get(diagnosticOperationKey(item))?.checkedAt;
      return !recoveredAt || recoveredAt <= item.checkedAt;
    })
  };
}

function diagnosticOperationKey(diagnostic: AccessDiagnostic): string {
  return `${diagnostic.operation || "unknown"}|${diagnostic.endpointLabel || ""}`;
}

function hasUnresolvedItemName(item: ActivationItem): boolean {
  const names = [item.sourceName, item.displayName]
    .filter((value): value is string => Boolean(value))
    .map(normalizeLookupValue);
  const identifiers = item.type === "directoryRole"
    ? [item.roleDefinitionId]
    : item.type === "pimGroup"
      ? [item.groupId]
      : [item.roleDefinitionId, leafIdentifier(item.roleDefinitionId)];

  return !names.length || names.some((name) =>
    name === "unknown-role" ||
    name === "unknown-group" ||
    name === "unknown azure role" ||
    identifiers.some((identifier) => normalizeLookupValue(identifier) === name)
  );
}

function hasUnresolvedScopeName(item: ActivationItem): boolean {
  if (item.type === "pimGroup") {
    return false;
  }
  if (item.type === "directoryRole") {
    return item.directoryScopeId !== "/" && normalizeLookupValue(item.scopeLabel) === normalizeLookupValue(item.directoryScopeId);
  }
  return normalizeLookupValue(item.scopeLabel) === normalizeLookupValue(item.scope);
}

function normalizeLookupValue(value: string | undefined): string {
  return (value || "").trim().toLowerCase();
}

function leafIdentifier(value: string | undefined): string {
  return (value || "").split("/").filter(Boolean).pop() || "";
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

export function isTargetCacheKeyForCurrentIdentity(
  cacheKey: string | undefined,
  tokenStatus: TokenStatus | null | undefined,
  target: AccessSetupTarget
): boolean {
  if (!cacheKey) {
    return false;
  }
  const token = getTokenStatusForTarget(target, tokenStatus);
  if (!token?.hasToken || token.isExpired || !token.tenantId || !token.principalId) {
    return false;
  }
  const label = target === "azureRole" ? "azure" : target === "directoryRole" ? "graphDirectory" : "graphPimGroup";
  return cacheKey.startsWith(`${label}:${token.tenantId}:${token.principalId}:`);
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
  // The capture timestamp is a non-secret token-generation marker. A new
  // portal token can carry the same visible scopes but different effective
  // capability, so it must trigger one authoritative API recheck.
  const now = Date.now();
  const capturedAt = Number(token.capturedAt);
  const generation = Number.isFinite(capturedAt) && capturedAt > 0 && capturedAt <= now + 5 * 60_000
    ? String(Math.floor(capturedAt))
    : "unknown";
  return `${label}:${identity}${scopes}:generation=${generation}`;
}

function buildAccessCapabilityItem(
  target: AccessSetupTarget,
  tokenStatus: TokenStatus | null | undefined,
  diagnostics: AccessDiagnostic[],
  hasLoadedItems: boolean
): AccessCapabilityItem {
  const token = getTokenStatusForTarget(target, tokenStatus);
  const summary = summarizeAccessDiagnostics(diagnostics);
  const latestEligibleDiagnostic = getLatestDiagnosticForOperation(diagnostics, "eligible");
  const latestActiveDiagnostic = getLatestDiagnosticForOperation(diagnostics, "active");
  const latestBlockedCoreDiagnostic = [latestEligibleDiagnostic, latestActiveDiagnostic]
    .filter((diagnostic): diagnostic is AccessDiagnostic => Boolean(
      diagnostic
      && !diagnostic.success
      && isPermissionOrAuthFailure(diagnostic.error)
    ))
    .sort((left, right) => right.checkedAt.localeCompare(left.checkedAt))[0];
  const latestCoreSuccess = latestEligibleDiagnostic?.success
    ? latestEligibleDiagnostic
    : latestActiveDiagnostic?.success
      ? latestActiveDiagnostic
      : undefined;
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

  if (latestBlockedCoreDiagnostic) {
    return {
      target,
      label: TARGET_LABELS[target],
      status: "limited",
      detail: hasLoadedItems
        ? "Cached data is available, but the latest Microsoft API check was blocked."
        : "The portal token was captured, but this feature is still blocked by Microsoft API access.",
      lastError: latestBlockedCoreDiagnostic.error,
      recommendedAction: getRecommendedAction(
        target,
        latestBlockedCoreDiagnostic.failureKind || classifyAccessFailure(latestBlockedCoreDiagnostic.error)
      ),
      ...diagnosticMetadata
    };
  }

  if (latestCoreSuccess) {
    return {
      target,
      label: TARGET_LABELS[target],
      status: "ready",
      detail: "Last API check succeeded.",
      lastSuccessAt: latestCoreSuccess.checkedAt,
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

  return {
    target,
    label: TARGET_LABELS[target],
    status: "limited",
    detail: "A portal token is available, but QuickPIM++ has not yet verified this role source with Microsoft.",
    recommendedAction: "Recheck access. If Microsoft blocks the request, reload the matching portal page.",
    ...diagnosticMetadata
  };
}

function getLatestDiagnosticForOperation(
  diagnostics: AccessDiagnostic[],
  operation: AccessDiagnosticOperation
): AccessDiagnostic | undefined {
  const maximum = Date.now() + 5 * 60_000;
  return diagnostics
    .filter((item) => {
      const checkedAt = Date.parse(item.checkedAt);
      const matchesOperation = item.operation === operation || (operation === "eligible" && item.operation === undefined);
      return matchesOperation && Number.isFinite(checkedAt) && checkedAt <= maximum;
    })
    .sort((a, b) => b.checkedAt.localeCompare(a.checkedAt))[0];
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
    lastError: `Missing activation scope: ${requiredScopes}. Open Role Access and reload the matching Microsoft portal page.`
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
