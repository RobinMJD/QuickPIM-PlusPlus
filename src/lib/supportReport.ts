import { sanitizeErrorMessage } from "./security";
import { getIdentityContext } from "./identityContext";
import { browserFamilyLabel, distributionLabel, type ExtensionDistributionInfo } from "./distribution";
import type { BrowserSyncStatus } from "./browserSync";
import type {
  ActivationItem,
  CachedActivationEntry,
  QuickPimDataCache,
  QuickPimSettings,
  TokenStatus,
  TokenStatusEntry,
  TrackedPimRequestStore
} from "./types";

export interface SupportReportInput {
  appVersion: string;
  buildTimestamp: string;
  settings: QuickPimSettings;
  tokenStatus: TokenStatus | null;
  dataCache: QuickPimDataCache;
  trackedRequests: TrackedPimRequestStore;
  distribution?: ExtensionDistributionInfo | null;
  browserSync?: BrowserSyncStatus | null;
  notificationPermissionGranted?: boolean;
  userAgent?: string;
  now?: Date;
}

export function buildSupportReport(input: SupportReportInput): Record<string, unknown> {
  const identity = getIdentityContext(input.tokenStatus);
  const cacheEntries = [
    input.dataCache.eligible,
    input.dataCache.active,
    ...Object.values(input.dataCache.eligibleByTarget || {}),
    ...Object.values(input.dataCache.activeByTarget || {})
  ].filter((entry): entry is CachedActivationEntry => Boolean(entry));
  const cachedItems = cacheEntries.flatMap((entry) => entry.items);

  return {
    reportVersion: 1,
    generatedAt: (input.now || new Date()).toISOString(),
    application: {
      version: input.appVersion,
      buildTimestamp: input.buildTimestamp,
      userAgent: sanitizeUserAgent(input.userAgent),
      installation: input.distribution ? {
        browser: browserFamilyLabel(input.distribution.browser),
        source: distributionLabel(input.distribution.distribution),
        installType: input.distribution.installType,
        supported: !input.distribution.blockedInEdge
      } : undefined
    },
    identity: {
      available: identity.identityCount > 0,
      mismatch: identity.mismatch,
      identityCount: identity.identityCount
    },
    tokens: {
      graph: summarizeToken(input.tokenStatus?.graph),
      graphDirectoryRole: summarizeToken(input.tokenStatus?.graphTargets?.directoryRole),
      graphPimGroup: summarizeToken(input.tokenStatus?.graphTargets?.pimGroup),
      azureManagement: summarizeToken(input.tokenStatus?.azureManagement)
    },
    settings: {
      enabledFeatures: [...input.settings.preferences.enabledFeatures],
      darkMode: input.settings.preferences.darkMode,
      backgroundPreRefreshEnabled: input.settings.preferences.backgroundPreRefreshEnabled,
      requestNotificationsEnabled: input.settings.preferences.requestNotificationsEnabled,
      notificationPermissionGranted: input.notificationPermissionGranted,
      notificationDeliveryReady: input.settings.preferences.requestNotificationsEnabled && input.notificationPermissionGranted === true,
      showAssignedRoles: input.settings.preferences.showAssignedRoles,
      counts: {
        aliases: Object.keys(input.settings.aliasesByItemId).length,
        favorites: input.settings.favoriteItemIds.length,
        savedJustifications: input.settings.savedJustifications.length,
        bundles: input.settings.bundles.length,
        activityHistory: input.settings.activityHistory.length
      }
    },
    browserSync: input.browserSync ? {
      capability: input.browserSync.capability,
      supported: input.browserSync.supported,
      enabled: input.browserSync.enabled,
      ecosystem: input.browserSync.ecosystemLabel,
      lastSuccessAt: input.browserSync.lastSuccessAt,
      hasError: Boolean(input.browserSync.lastError),
      suspendedByPurge: input.browserSync.suspendedByPurge,
      knownInstallationCount: input.browserSync.devices.length,
      omittedCategories: input.browserSync.omittedCategories
    } : undefined,
    cache: {
      entryCount: cacheEntries.length,
      itemCounts: countItems(cachedItems),
      entries: cacheEntries.map(summarizeCacheEntry)
    },
    trackedRequests: countTrackedRequests(input.trackedRequests),
    privacy: "No tokens, authorization headers, role names, object ids, ticket data, or justification text are included."
  };
}

export function stringifySupportReport(input: SupportReportInput): string {
  return JSON.stringify(buildSupportReport(input), null, 2);
}

function summarizeToken(status: TokenStatusEntry | undefined): Record<string, unknown> {
  return {
    present: Boolean(status?.hasToken),
    expired: Boolean(status?.isExpired),
    tokenAgeMinutes: status?.tokenAge,
    expiresInMinutes: status?.expiresInMinutes,
    source: summarizeTokenSource(status?.source),
    grantedScopes: status?.grantedScopes || []
  };
}

function summarizeTokenSource(source: string | undefined): string | undefined {
  if (!source) return undefined;
  if (source === "Microsoft Entra portal storage" || source.startsWith("entra.microsoft.com storage")) {
    return "Microsoft Entra portal storage";
  }
  if (source === "Microsoft Entra portal request" || source.startsWith("https://entra.microsoft.com")) {
    return "Microsoft Entra portal request";
  }
  return "Captured Microsoft portal token";
}

function summarizeCacheEntry(entry: CachedActivationEntry): Record<string, unknown> {
  return {
    fetchedAt: entry.fetchedAt,
    itemCounts: countItems(entry.items),
    errors: entry.errors.map((error) => sanitizeReportText(error)),
    diagnostics: (entry.diagnostics || []).map((diagnostic) => ({
      target: diagnostic.target,
      success: diagnostic.success,
      checkedAt: diagnostic.checkedAt,
      fromCache: diagnostic.fromCache,
      operation: diagnostic.operation,
      endpointLabel: diagnostic.endpointLabel,
      failureKind: diagnostic.failureKind,
      error: diagnostic.error ? sanitizeReportText(diagnostic.error) : undefined
    }))
  };
}

function countItems(items: ActivationItem[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = `${item.type}:${item.status}`;
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function countTrackedRequests(store: TrackedPimRequestStore): Record<string, number> {
  const counts: Record<string, number> = { total: store.requests.length };
  for (const request of store.requests) {
    const key = `${request.action}:${request.status}`;
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function sanitizeReportText(value: string): string {
  return sanitizeErrorMessage(value)
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "[redacted id]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted account]")
    .slice(0, 500);
}

function sanitizeUserAgent(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.replace(/\([^)]*\)/g, "(platform redacted)").slice(0, 300);
}
