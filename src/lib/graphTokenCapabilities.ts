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

const DIRECTORY_ROLE_ACTIVATION_SCOPES = ["RoleAssignmentSchedule.ReadWrite.Directory", "RoleManagement.ReadWrite.Directory"];
const PIM_GROUP_ACTIVATION_SCOPES = ["PrivilegedAssignmentSchedule.ReadWrite.AzureADGroup", "PrivilegedAccess.ReadWrite.AzureADGroup"];
const MFA_AUTH_METHODS = new Set(["mfa", "fido", "rsa"]);
const CHALLENGE_AUTH_CONTEXTS = new Set(["c1", "c2", "c3", "pfdr"]);

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
  const activationMatches = getRequiredGraphActivationScopes(target).filter((scope) => scopes.has(scope)).length;
  if (activationMatches) {
    return 200 + activationMatches * 10 + exactMatches;
  }
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

export function getRequiredGraphActivationScopes(target: GraphTokenTarget): string[] {
  return target === "directoryRole" ? DIRECTORY_ROLE_ACTIVATION_SCOPES : PIM_GROUP_ACTIVATION_SCOPES;
}

export function getMatchedGraphActivationScope(target: GraphTokenTarget, scopes: Set<string>): string | undefined {
  return getRequiredGraphActivationScopes(target).find((scope) => scopes.has(scope));
}

export function hasGraphActivationScope(decoded: Record<string, unknown>, target: GraphTokenTarget): boolean {
  return Boolean(getMatchedGraphActivationScope(target, getGrantedTokenScopes(decoded)));
}

export function getGraphTokenAuthStrengthScore(decoded: Record<string, unknown>): number {
  const authMethods = getStringClaimValues(decoded.amr);
  const authContexts = getStringClaimValues(decoded.acrs);
  let score = 0;

  if (authMethods.some((method) => MFA_AUTH_METHODS.has(method.toLowerCase()))) {
    score += 100;
  }

  score += authContexts.filter((context) => CHALLENGE_AUTH_CONTEXTS.has(context.toLowerCase())).length * 25;
  return score;
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

function getStringClaimValues(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  return typeof value === "string" ? [value] : [];
}
