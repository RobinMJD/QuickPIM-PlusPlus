import { CLAIMS_CHALLENGE_MESSAGE, isClaimsChallengeMessage } from "./apiErrors";
import { normalizeActivationItemId } from "./activationIdentity";
import type { AccessSetupTarget, ActivationResponse } from "./types";

export function getAccessRecoveryTargets(response: ActivationResponse): AccessSetupTarget[] {
  const requested = new Set(
    response.errors.flatMap((result) => result.accessRecoveryTarget ? [result.accessRecoveryTarget] : [])
  );
  return (["directoryRole", "pimGroup", "azureRole"] as AccessSetupTarget[])
    .filter((target) => requested.has(target));
}

export function getFreshAccessRecoveryTargets(response: ActivationResponse): AccessSetupTarget[] {
  const requested = new Set(
    response.errors.flatMap((result) => result.accessRecoveryTarget ? [result.accessRecoveryTarget] : [])
  );
  return (["directoryRole", "pimGroup", "azureRole"] as AccessSetupTarget[])
    .filter((target) => requested.has(target));
}

export function getClaimsChallengeRecoveryTargets(response: ActivationResponse): AccessSetupTarget[] {
  const requested = new Set(
    response.errors.flatMap((result) =>
      result.accessRecoveryTarget && isFreshPortalTokenRequired(result.error)
        ? [result.accessRecoveryTarget]
        : []
    )
  );
  return (["directoryRole", "pimGroup", "azureRole"] as AccessSetupTarget[])
    .filter((target) => requested.has(target));
}

export function isFreshPortalTokenRequired(error: string | undefined): boolean {
  const message = error || "";
  return message === CLAIMS_CHALLENGE_MESSAGE || isClaimsChallengeMessage(message);
}

export function mergeRetriedActivationResponse(
  initialResponse: ActivationResponse,
  retryResponse: ActivationResponse
): ActivationResponse {
  const retryResults = new Map(retryResponse.results.map((result) => [normalizeActivationItemId(result.itemId), result]));
  const results = initialResponse.results.map((result) => retryResults.get(normalizeActivationItemId(result.itemId)) || result);
  const errors = results.filter((result) => !result.success);
  return {
    success: errors.length === 0,
    results,
    errors
  };
}

export function replaceAccessRecoveryErrors(response: ActivationResponse, error: string): ActivationResponse {
  const results = response.results.map((result) => result.accessRecoveryTarget && !result.success
    ? { ...result, error }
    : result);
  return {
    success: false,
    results,
    errors: results.filter((result) => !result.success)
  };
}

export function shouldFocusPortalRecovery(options: {
  elapsedMs: number;
  interactionRequired: boolean;
  requiresFreshToken: boolean;
  focusAttempts: number;
}): boolean {
  if (options.focusAttempts >= 2) return false;
  if (options.interactionRequired) return true;
  const graceMs = options.requiresFreshToken ? 3_000 : 12_000;
  return options.elapsedMs >= graceMs + options.focusAttempts * 10_000;
}

export function getPortalRecoveryFailureMessage(options: {
  remainingTargets: AccessSetupTarget[];
  claimsChallengeTargets: AccessSetupTarget[];
  interactionRequired: boolean;
  targetLabel: (target: AccessSetupTarget) => string;
}): string {
  if (
    options.interactionRequired
    || options.remainingTargets.some((target) => options.claimsChallengeTargets.includes(target))
  ) {
    return CLAIMS_CHALLENGE_MESSAGE;
  }
  return `QuickPIM++ could not capture ${options.remainingTargets.map(options.targetLabel).join(" and ")} request access in time. Your selection and inputs remain saved.`;
}
