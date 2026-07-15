import type { AccessCapabilityItem } from "./access";

export function filterLoadErrorsForAccessState(
  errors: string[],
  accessCapabilities: AccessCapabilityItem[]
): string[] {
  if (!accessCapabilities.length) {
    return errors;
  }

  // Access limitations already have a feature-specific warning and recovery path.
  // Keep the red progress state for refresh failures that are not explained there.
  return errors.filter((error) => !isPermissionOrAuthLoadError(error));
}

function isPermissionOrAuthLoadError(error: string): boolean {
  return /permissionscope|missing permission|authorization failed|does not have authorization|insufficient privileges|forbidden|token is missing|access token expiry utc time|token (has )?expired|claims challenge|additional sign-in|mfa challenge|interaction_required/i.test(error);
}
