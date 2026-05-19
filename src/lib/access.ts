import { ENTRA_GRAPH_BOOTSTRAP_URLS, ENTRA_PORTAL_URLS } from "./popupModel";
import type {
  AccessCapabilityStatus,
  AccessDiagnostic,
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
  lastError?: string;
}

const TARGET_LABELS: Record<AccessSetupTarget, string> = {
  directoryRole: "Entra Roles",
  pimGroup: "PIM Groups",
  azureRole: "Azure Roles"
};

const TARGET_REQUIRED_SCOPES: Record<AccessSetupTarget, string[]> = {
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
  cache: QuickPimDataCache | undefined
): AccessCapabilityItem[] {
  const diagnostics = collectDiagnostics(cache);
  const loadedTargets = collectLoadedTargets(cache);
  return (["directoryRole", "pimGroup", "azureRole"] as AccessSetupTarget[]).map((target) =>
    buildAccessCapabilityItem(target, tokenStatus, diagnostics.filter((item) => item.target === target), loadedTargets.has(target))
  );
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

export function buildTokenCacheKey(tokenStatus: TokenStatus | null | undefined): string {
  return [
    buildTokenCachePart("graph", tokenStatus?.graph),
    buildTokenCachePart("azure", tokenStatus?.azureManagement)
  ].join("|");
}

function buildTokenCachePart(label: string, token: TokenStatusEntry | undefined): string {
  if (!token?.hasToken || token.isExpired) {
    return `${label}:missing`;
  }

  const scopes = [...(token.grantedScopes || [])].sort((a, b) => a.localeCompare(b)).join(",");
  return `${label}:${token.expiresAt || ""}:${scopes}`;
}

function buildAccessCapabilityItem(
  target: AccessSetupTarget,
  tokenStatus: TokenStatus | null | undefined,
  diagnostics: AccessDiagnostic[],
  hasLoadedItems: boolean
): AccessCapabilityItem {
  const token = getTokenStatusForTarget(target, tokenStatus);
  const latestDiagnostic = [...diagnostics].sort((a, b) => b.checkedAt.localeCompare(a.checkedAt))[0];
  const latestSuccess = [...diagnostics]
    .filter((item) => item.success)
    .sort((a, b) => b.checkedAt.localeCompare(a.checkedAt))[0];

  if (!token?.hasToken || token.isExpired) {
    return {
      target,
      label: TARGET_LABELS[target],
      status: "needsPortalRefresh",
      detail: token?.isExpired ? "Captured token expired. Open the portal to refresh it." : "Open the portal so QuickPIM++ can capture a token."
    };
  }

  if (latestSuccess) {
    return {
      target,
      label: TARGET_LABELS[target],
      status: "ready",
      detail: "Last API check succeeded.",
      lastSuccessAt: latestSuccess.checkedAt
    };
  }

  if (hasLoadedItems) {
    return {
      target,
      label: TARGET_LABELS[target],
      status: "ready",
      detail: "Loaded eligible or active items."
    };
  }

  if (latestDiagnostic && !latestDiagnostic.success && isPermissionOrAuthFailure(latestDiagnostic.error)) {
    return {
      target,
      label: TARGET_LABELS[target],
      status: "limited",
      detail: "The portal token was captured, but this feature is still blocked by Microsoft API access.",
      lastError: latestDiagnostic.error
    };
  }

  if (target === "azureRole") {
    return {
      target,
      label: TARGET_LABELS[target],
      status: "ready",
      detail: "Azure Management token captured."
    };
  }

  const grantedScopes = new Set(token.grantedScopes || []);
  const matchedScope = TARGET_REQUIRED_SCOPES[target].find((scope) => grantedScopes.has(scope));
  if (matchedScope) {
    return {
      target,
      label: TARGET_LABELS[target],
      status: "ready",
      detail: `Token includes ${matchedScope}.`
    };
  }

  return {
    target,
    label: TARGET_LABELS[target],
    status: "needsPortalRefresh",
    detail: "Open the matching portal page so Microsoft can request the needed access."
  };
}

function getTokenStatusForTarget(
  target: AccessSetupTarget,
  tokenStatus: TokenStatus | null | undefined
): TokenStatusEntry | undefined {
  return target === "azureRole" ? tokenStatus?.azureManagement : tokenStatus?.graph;
}

function collectDiagnostics(cache: QuickPimDataCache | undefined): AccessDiagnostic[] {
  return [cache?.eligible, cache?.active].flatMap((entry) => entry?.diagnostics || []);
}

function collectLoadedTargets(cache: QuickPimDataCache | undefined): Set<AccessSetupTarget> {
  return new Set(
    [cache?.eligible, cache?.active]
      .flatMap((entry) => entry?.items || [])
      .map((item) => item.type)
  );
}

function isPermissionOrAuthFailure(error: string | undefined): boolean {
  if (!error) {
    return false;
  }

  return /403|forbidden|authorization failed|permissionscope|missing permission|does not have authorization/i.test(error);
}
