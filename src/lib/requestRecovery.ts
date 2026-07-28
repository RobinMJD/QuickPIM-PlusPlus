import { CLAIMS_CHALLENGE_MESSAGE, isClaimsChallengeMessage } from "./apiErrors";
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
  const retryResults = new Map(retryResponse.results.map((result) => [result.itemId, result]));
  const results = initialResponse.results.map((result) => retryResults.get(result.itemId) || result);
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
