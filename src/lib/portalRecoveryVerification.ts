import { buildTargetCacheKeys, hasRequiredPortalToken } from "./access";
import type {
  AccessSetupTarget,
  CachedActivationEntry,
  QuickPimDataCache,
  TokenStatus
} from "./types";

export interface PortalRecoveryVerificationOptions {
  tokenStatus: TokenStatus;
  cache: QuickPimDataCache;
  targets: AccessSetupTarget[];
  journeyCreatedAt: number;
}

/**
 * Returns only targets whose eligible and active endpoints were successfully
 * checked with the current token generation after this recovery journey began.
 */
export function getApiVerifiedPortalRecoveryTargets(
  options: PortalRecoveryVerificationOptions
): AccessSetupTarget[] {
  const cacheKeys = buildTargetCacheKeys(options.tokenStatus, options.targets);
  return uniqueTargets(options.targets).filter((target) => {
    if (!hasRequiredPortalToken(target, options.tokenStatus)) return false;
    const cacheKey = cacheKeys[target];
    return isVerifiedEntry(
      options.cache.eligibleByTarget?.[target],
      target,
      "eligible",
      cacheKey,
      options.journeyCreatedAt
    ) && isVerifiedEntry(
      options.cache.activeByTarget?.[target],
      target,
      "active",
      cacheKey,
      options.journeyCreatedAt
    );
  });
}

function isVerifiedEntry(
  entry: CachedActivationEntry | undefined,
  target: AccessSetupTarget,
  operation: "eligible" | "active",
  cacheKey: string | undefined,
  journeyCreatedAt: number
): boolean {
  if (
    !entry
    || !cacheKey
    || entry.cacheKey !== cacheKey
    || entry.fetchedAt < journeyCreatedAt
    || entry.errors.length > 0
  ) {
    return false;
  }

  return Boolean(entry.diagnostics?.some((diagnostic) =>
    diagnostic.target === target
    && diagnostic.operation === operation
    && diagnostic.success
    && Date.parse(diagnostic.checkedAt) >= journeyCreatedAt
  ));
}

function uniqueTargets(targets: AccessSetupTarget[]): AccessSetupTarget[] {
  const requested = new Set(targets);
  return (["directoryRole", "pimGroup", "azureRole"] as AccessSetupTarget[])
    .filter((target) => requested.has(target));
}
