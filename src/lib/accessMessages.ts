import { getAccessSetupTargets, type AccessCapabilityItem } from "./access";

export function filterLoadErrorsForAccessState(
  errors: string[],
  accessCapabilities: AccessCapabilityItem[]
): string[] {
  const hasAccessWarning = getAccessSetupTargets(accessCapabilities).length > 0;
  if (hasAccessWarning) {
    return errors;
  }

  return errors.filter((error) => !isPermissionOrAuthLoadError(error));
}

function isPermissionOrAuthLoadError(error: string): boolean {
  return /permissionscope|missing permission|authorization failed|forbidden|access token expiry utc time|token (has )?expired/i.test(error);
}
