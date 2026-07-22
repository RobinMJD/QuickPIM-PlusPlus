import type { AccessSetupTarget, ActivationResponse } from "./types";

export function getAccessRecoveryTargets(response: ActivationResponse): AccessSetupTarget[] {
  const requested = new Set(
    response.errors.flatMap((result) => result.accessRecoveryTarget ? [result.accessRecoveryTarget] : [])
  );
  return (["directoryRole", "pimGroup", "azureRole"] as AccessSetupTarget[])
    .filter((target) => requested.has(target));
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
