import type { AccessSetupTarget } from "./types";

export type GraphTokenTarget = Exclude<AccessSetupTarget, "azureRole">;

const DIRECTORY_ROLE_SCOPES = [
  "RoleEligibilitySchedule.Read.Directory",
  "RoleEligibilitySchedule.ReadWrite.Directory",
  "RoleAssignmentSchedule.Read.Directory",
  "RoleAssignmentSchedule.ReadWrite.Directory",
  "RoleManagement.Read.All",
  "RoleManagement.Read.Directory",
  "RoleManagement.ReadWrite.Directory"
];

const PIM_GROUP_SCOPES = [
  "PrivilegedEligibilitySchedule.Read.AzureADGroup",
  "PrivilegedEligibilitySchedule.ReadWrite.AzureADGroup",
  "PrivilegedAssignmentSchedule.Read.AzureADGroup",
  "PrivilegedAssignmentSchedule.ReadWrite.AzureADGroup",
  "PrivilegedAccess.Read.AzureADGroup",
  "PrivilegedAccess.ReadWrite.AzureADGroup"
];

export const GRAPH_TOKEN_TARGETS: GraphTokenTarget[] = ["directoryRole", "pimGroup"];

export function getGrantedTokenScopes(decoded: Record<string, unknown>): Set<string> {
  const scopes = typeof decoded.scp === "string" ? decoded.scp.split(/\s+/).filter(Boolean) : [];
  const roles = Array.isArray(decoded.roles) ? decoded.roles.filter((role): role is string => typeof role === "string") : [];
  return new Set([...scopes, ...roles]);
}

export function getGraphTokenTargets(decoded: Record<string, unknown>): GraphTokenTarget[] {
  const scopes = getGrantedTokenScopes(decoded);
  return GRAPH_TOKEN_TARGETS.filter((target) => getGraphTokenTargetScore(decoded, target, scopes) > 0);
}

export function getGraphTokenTargetScore(
  decoded: Record<string, unknown>,
  target: GraphTokenTarget,
  scopes = getGrantedTokenScopes(decoded)
): number {
  const targetScopes = target === "directoryRole" ? DIRECTORY_ROLE_SCOPES : PIM_GROUP_SCOPES;
  const exactMatches = targetScopes.filter((scope) => scopes.has(scope)).length;
  if (exactMatches) {
    return 100 + exactMatches;
  }

  if (target === "directoryRole" && [...scopes].some((scope) => /^Role(Eligibility|Assignment|Management)\./i.test(scope))) {
    return 10;
  }

  if (target === "pimGroup" && [...scopes].some((scope) => /^Privileged/i.test(scope) && /AzureADGroup/i.test(scope))) {
    return 10;
  }

  return 0;
}

export function getGraphTokenOverallScore(decoded: Record<string, unknown>): number {
  const scopes = getGrantedTokenScopes(decoded);
  const directoryScore = getGraphTokenTargetScore(decoded, "directoryRole", scopes);
  const pimGroupScore = getGraphTokenTargetScore(decoded, "pimGroup", scopes);
  const broadPrivilegedScore = [...scopes].some((scope) => /^RoleManagement\.Read/i.test(scope) || /^Privileged/i.test(scope))
    ? 5
    : 0;
  return directoryScore + pimGroupScore + broadPrivilegedScore + Math.min(scopes.size, 20);
}
