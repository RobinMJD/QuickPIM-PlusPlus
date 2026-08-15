import type {
  ActivitySource,
  ActivationHistoryEntry,
  ActivationItem,
  ActivationResponse,
  ActivityHistoryEntry,
  ActivityResult,
  BundleExpansion,
  QuickPimBundle,
  QuickPimFeature,
  ReferenceDataCache,
  QuickPimSettings,
  SortDirection,
  SortMode,
  UsageStats
} from "./types";
import { createStorageMutationLock } from "./storageMutation";
import { sendRuntimeMessage } from "./runtimeMessaging";
import { MAX_ACTIVATION_DURATION_HOURS, MIN_ACTIVATION_DURATION_HOURS } from "./duration";
import { getReferenceDisplayName, getReferenceScopeLabel } from "./referenceData";
import {
  isGenericJustification,
  sanitizeUserJustification
} from "./justifications";
import { isSafeRecordKey, sanitizeErrorMessage } from "./security";
import { DEFAULT_EXTENSION_DURATION_HOURS, sanitizeExtensionDurationHours } from "./requestExtension";
import {
  getActivationItemIdentity,
  getActivationItemIdentityCandidates,
  getLegacyActivationItemIdentity,
  normalizeActivationItemId
} from "./activationIdentity";

export const SETTINGS_KEY = "quickPimSettings.v1";
export const SETTINGS_REVISION_KEY = "quickPimSettingsRevision.v1";
const MAX_SETTINGS_MUTATION_ATTEMPTS = 8;
const MAX_HISTORY_ENTRIES = 50;
const MAX_ACTIVITY_HISTORY_ENTRIES = 200;
const MAX_ALIASES = 300;
const MAX_FAVORITES = 300;
const MAX_ALIAS_LENGTH = 120;
const MAX_ITEM_ID_LENGTH = 512;
const MAX_ACTIVITY_EVENT_ID_LENGTH = 256;
const MAX_SAVED_JUSTIFICATIONS = 100;
const MAX_BUNDLES = 50;
const MAX_BUNDLE_ITEMS = 100;
const MAX_BUNDLE_NAME_LENGTH = 80;
const MAX_TIMESTAMP_FUTURE_SKEW_MS = 5 * 60_000;
export const ROLE_FEATURES: Array<ActivationItem["type"]> = ["directoryRole", "pimGroup", "azureRole"];
export const ALL_FEATURES: QuickPimFeature[] = [...ROLE_FEATURES, "bundles"];
const withSettingsMutationLock = createStorageMutationLock("quickPimSettingsMutation");

export function runWithSettingsMutationLock<T>(operation: () => Promise<T>): Promise<T> {
  return withSettingsMutationLock(operation);
}

export interface SettingsStorageAreaLike {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export interface SettingsSnapshot {
  settings: QuickPimSettings;
  revision: number;
  needsNormalization?: boolean;
}

export interface SettingsCompareAndSetResult extends SettingsSnapshot {
  applied: boolean;
}

export const DEFAULT_SETTINGS: QuickPimSettings = {
  version: 2,
  aliasesByItemId: {},
  favoriteItemIds: [],
  savedJustifications: [],
  recentJustifications: [],
  bundles: [],
  usageStatsByItemId: {},
  activityHistory: [],
  activationHistory: [],
  preferences: {
    defaultDurationHours: 0.5,
    defaultExtensionDurationHours: DEFAULT_EXTENSION_DURATION_HOURS,
    defaultSort: "name",
    defaultSortDirection: "ascending",
    recentJustificationLimit: 8,
    activityHistoryLimit: 100,
    darkMode: false,
    showAssignedRoles: false,
    showRemainingActivationTime: true,
    showActivationCounters: false,
    showEnablementDetails: false,
    showLastEnablementDate: false,
    backgroundPreRefreshEnabled: true,
    requestNotificationsEnabled: false,
    expiryReminderMinutes: 15,
    enabledFeatures: ALL_FEATURES,
    autoEnabledFeaturesInitialized: false,
    permissionWarningIgnored: false
  }
};

export function mergeSettings(input: Partial<QuickPimSettings> | undefined): QuickPimSettings {
  const source = isRecord(input) ? input : {};
  const preferences = sanitizePreferences(source.preferences);
  return {
    ...DEFAULT_SETTINGS,
    aliasesByItemId: sanitizeAliases(source.aliasesByItemId),
    favoriteItemIds: sanitizeFavoriteItemIds(source.favoriteItemIds),
    usageStatsByItemId: sanitizeUsageStats(source.usageStatsByItemId),
    preferences,
    savedJustifications: sanitizeJustificationList(source.savedJustifications, MAX_SAVED_JUSTIFICATIONS),
    recentJustifications: sanitizeJustificationList(source.recentJustifications, preferences.recentJustificationLimit),
    bundles: sanitizeBundles(source.bundles),
    activityHistory: sanitizeActivityHistory(source.activityHistory, source.activationHistory, source.preferences),
    activationHistory: sanitizeActivationHistory(source.activationHistory),
    version: 2
  };
}

export function mergeImportedSettings(current: QuickPimSettings, input: Partial<QuickPimSettings>): QuickPimSettings {
  const preferences = isRecord(input.preferences)
    ? { ...current.preferences, ...input.preferences }
    : current.preferences;
  return mergeSettings({ ...current, ...input, preferences });
}

export async function loadSettings(): Promise<QuickPimSettings> {
  return loadSettingsFromStorage(chrome.storage.local);
}

export async function loadSettingsSnapshot(): Promise<SettingsSnapshot> {
  return loadSettingsSnapshotFromStorage(chrome.storage.local);
}

export async function loadSettingsSnapshotInStorage(
  storage: SettingsStorageAreaLike
): Promise<SettingsSnapshot> {
  return loadSettingsSnapshotFromStorage(storage);
}

export async function mutateSettings(
  mutator: (current: QuickPimSettings) => QuickPimSettings | Promise<QuickPimSettings>
): Promise<QuickPimSettings> {
  return mutateSettingsInStorage(chrome.storage.local, mutator);
}

export async function mutateSettingsInStorage(
  storage: SettingsStorageAreaLike,
  mutator: (current: QuickPimSettings) => QuickPimSettings | Promise<QuickPimSettings>
): Promise<QuickPimSettings> {
  return withSettingsMutationLock(async () => {
    const snapshot = await loadSettingsSnapshotFromStorage(storage);
    const next = mergeSettings(await mutator(snapshot.settings));
    if (snapshot.needsNormalization || JSON.stringify(snapshot.settings) !== JSON.stringify(next)) {
      await storage.set({
        [SETTINGS_KEY]: next,
        [SETTINGS_REVISION_KEY]: snapshot.revision + 1
      });
    }
    return next;
  });
}

export async function compareAndSetSettings(
  expectedRevision: number,
  candidate: QuickPimSettings
): Promise<SettingsCompareAndSetResult> {
  return compareAndSetSettingsInStorage(chrome.storage.local, expectedRevision, candidate);
}

export async function compareAndSetSettingsInStorage(
  storage: SettingsStorageAreaLike,
  expectedRevision: number,
  candidate: QuickPimSettings
): Promise<SettingsCompareAndSetResult> {
  return withSettingsMutationLock(async () => {
    const snapshot = await loadSettingsSnapshotFromStorage(storage);
    if (snapshot.revision !== expectedRevision) {
      return { ...snapshot, applied: false };
    }
    const next = mergeSettings(candidate);
    if (!snapshot.needsNormalization && JSON.stringify(snapshot.settings) === JSON.stringify(next)) {
      return { settings: snapshot.settings, revision: snapshot.revision, applied: true };
    }
    const revision = snapshot.revision + 1;
    await storage.set({
      [SETTINGS_KEY]: next,
      [SETTINGS_REVISION_KEY]: revision
    });
    return { settings: next, revision, applied: true };
  });
}

export async function mutateSettingsViaBackground(
  mutator: (current: QuickPimSettings) => QuickPimSettings | Promise<QuickPimSettings>
): Promise<QuickPimSettings> {
  let snapshot = await sendRuntimeMessage<SettingsSnapshot>({ action: "getSettingsSnapshot" });
  if (!isSettingsSnapshot(snapshot)) {
    // Unit/component harnesses intentionally expose only a partial Chrome
    // runtime. A real extension context always provides getURL and must fail
    // closed rather than bypassing the authoritative background mutation path.
    if (
      typeof chrome.runtime?.getURL !== "function"
      || typeof chrome.runtime?.getManifest !== "function"
      || (typeof navigator !== "undefined" && /jsdom/i.test(navigator.userAgent))
    ) {
      return mutateSettings(mutator);
    }
    throw new Error("QuickPIM++ could not read the current settings revision. Reload the extension and retry.");
  }
  for (let attempt = 0; attempt < MAX_SETTINGS_MUTATION_ATTEMPTS; attempt += 1) {
    const candidate = mergeSettings(await mutator(snapshot.settings));
    if (JSON.stringify(candidate) === JSON.stringify(snapshot.settings)) {
      return snapshot.settings;
    }
    const result = await sendRuntimeMessage<SettingsCompareAndSetResult>({
      action: "compareAndSetSettings",
      expectedRevision: snapshot.revision,
      settings: candidate
    });
    if (!isSettingsCompareAndSetResult(result)) {
      throw new Error("QuickPIM++ received an invalid settings update response. Reload the extension and retry.");
    }
    if (result.applied) {
      return result.settings;
    }
    snapshot = result;
  }
  throw new Error("Settings changed repeatedly in another QuickPIM++ window. Please retry your change.");
}

function isSettingsSnapshot(value: unknown): value is SettingsSnapshot {
  return Boolean(
    value
    && typeof value === "object"
    && Number.isSafeInteger((value as SettingsSnapshot).revision)
    && (value as SettingsSnapshot).revision >= 0
    && (value as SettingsSnapshot).settings
    && typeof (value as SettingsSnapshot).settings === "object"
  );
}

function isSettingsCompareAndSetResult(value: unknown): value is SettingsCompareAndSetResult {
  return isSettingsSnapshot(value) && typeof (value as SettingsCompareAndSetResult).applied === "boolean";
}

async function loadSettingsFromStorage(storage: SettingsStorageAreaLike): Promise<QuickPimSettings> {
  const result = await storage.get(SETTINGS_KEY);
  return mergeSettings(result[SETTINGS_KEY] as Partial<QuickPimSettings> | undefined);
}

async function loadSettingsSnapshotFromStorage(storage: SettingsStorageAreaLike): Promise<SettingsSnapshot> {
  const [settingsResult, revisionResult] = await Promise.all([
    storage.get(SETTINGS_KEY),
    storage.get(SETTINGS_REVISION_KEY)
  ]);
  const rawRevision = revisionResult[SETTINGS_REVISION_KEY];
  const revision = Number.isSafeInteger(rawRevision) && Number(rawRevision) >= 0 ? Number(rawRevision) : 0;
  const rawSettings = settingsResult[SETTINGS_KEY] as Partial<QuickPimSettings> | undefined;
  const settings = mergeSettings(rawSettings);
  return {
    settings,
    revision,
    needsNormalization: JSON.stringify(rawSettings) !== JSON.stringify(settings)
  };
}

export function getDisplayName(
  item: ActivationItem,
  settings: QuickPimSettings,
  referenceData?: ReferenceDataCache
): string {
  const alias = getActivationItemIdentityCandidates(item)
    .map((identity) => settings.aliasesByItemId[identity]?.trim())
    .find(Boolean);
  return alias || getReferenceDisplayName(item, referenceData) || item.displayName || item.sourceName || "Unknown";
}

export function getScopeLabel(item: ActivationItem, referenceData?: ReferenceDataCache): string {
  return getReferenceScopeLabel(item, referenceData) || item.scopeLabel || "Scope";
}

export function getUsage(item: ActivationItem, settings: QuickPimSettings) {
  return getActivationItemIdentityCandidates(item)
    .map((identity) => settings.usageStatsByItemId[identity])
    .find(Boolean) || { activationCount: 0 };
}

export function sortItems(
  items: ActivationItem[],
  settings: QuickPimSettings,
  sortMode: SortMode,
  referenceData?: ReferenceDataCache,
  sortDirection: SortDirection = getDefaultSortDirection(sortMode)
): ActivationItem[] {
  const sortable = [...items];
  const favoriteItemIds = new Set((settings.favoriteItemIds || []).map(normalizeActivationItemId));
  const isFavorite = (item: ActivationItem) => getActivationItemIdentityCandidates(item)
    .some((identity) => favoriteItemIds.has(normalizeActivationItemId(identity)));
  return sortable.sort((a, b) => {
    const favoriteDiff = Number(isFavorite(b)) - Number(isFavorite(a));
    if (favoriteDiff) {
      return favoriteDiff;
    }

    let comparison: number;
    if (sortMode === "lastUsed") {
      const aDate = getUsage(a, settings).lastUsedAt || "";
      const bDate = getUsage(b, settings).lastUsedAt || "";
      comparison = aDate.localeCompare(bDate) || getDisplayName(a, settings, referenceData).localeCompare(getDisplayName(b, settings, referenceData));
    } else if (sortMode === "activationCount") {
      const diff = getUsage(b, settings).activationCount - getUsage(a, settings).activationCount;
      comparison = -diff || getDisplayName(a, settings, referenceData).localeCompare(getDisplayName(b, settings, referenceData));
    } else if (sortMode === "scope") {
      comparison = getScopeLabel(a, referenceData).localeCompare(getScopeLabel(b, referenceData)) || getDisplayName(a, settings, referenceData).localeCompare(getDisplayName(b, settings, referenceData));
    } else {
      comparison = getDisplayName(a, settings, referenceData).localeCompare(getDisplayName(b, settings, referenceData));
    }
    return sortDirection === "descending" ? -comparison : comparison;
  });
}

export function getDefaultSortDirection(sortMode: SortMode): SortDirection {
  return sortMode === "lastUsed" || sortMode === "activationCount" ? "descending" : "ascending";
}

export function addRecentJustification(settings: QuickPimSettings, justification: string): QuickPimSettings {
  const trimmed = sanitizeUserJustification(justification);
  if (!trimmed || isGenericJustification(trimmed)) {
    return settings;
  }

  const limit = settings.preferences.recentJustificationLimit || DEFAULT_SETTINGS.preferences.recentJustificationLimit;
  const recentJustifications = [
    trimmed,
    ...settings.recentJustifications.filter((item) => item.toLowerCase() !== trimmed.toLowerCase())
  ].slice(0, limit);

  return {
    ...settings,
    recentJustifications
  };
}

export function addSavedJustification(settings: QuickPimSettings, justification: string): QuickPimSettings {
  const trimmed = sanitizeUserJustification(justification);
  if (!trimmed || isGenericJustification(trimmed)) {
    return settings;
  }

  const existing = settings.savedJustifications.some((item) => item.toLowerCase() === trimmed.toLowerCase());
  return {
    ...settings,
    savedJustifications: existing ? settings.savedJustifications : [trimmed, ...settings.savedJustifications]
  };
}

export function recordActivations(
  settings: QuickPimSettings,
  items: ActivationItem[],
  activatedAt = new Date().toISOString(),
  bundleName?: string,
  source?: ActivitySource
): QuickPimSettings {
  const usageStatsByItemId = { ...settings.usageStatsByItemId };

  for (const item of items) {
    const itemId = getActivationItemIdentity(item);
    if (!isSafeRecordKey(itemId)) continue;
    const current = usageStatsByItemId[itemId]
      || (!item.tenantId ? usageStatsByItemId[getLegacyActivationItemIdentity(item)] : undefined)
      || { activationCount: 0 };
    if (source?.installationId && isSafeRecordKey(source.installationId)) {
      const byInstallationId = { ...current.byInstallationId };
      const currentSource = byInstallationId[source.installationId] || { activationCount: 0 };
      byInstallationId[source.installationId] = {
        activationCount: currentSource.activationCount + 1,
        lastUsedAt: activatedAt
      };
      const knownTotal = Object.values(byInstallationId).reduce((total, entry) => total + entry.activationCount, 0);
      const previousKnownTotal = Object.values(current.byInstallationId || {}).reduce((total, entry) => total + entry.activationCount, 0);
      const legacyActivationCount = current.legacyActivationCount ?? Math.max(0, current.activationCount - previousKnownTotal);
      usageStatsByItemId[itemId] = {
        activationCount: legacyActivationCount + knownTotal,
        lastUsedAt: latestIsoTimestamp(current.lastUsedAt, activatedAt),
        ...(legacyActivationCount ? { legacyActivationCount } : {}),
        byInstallationId
      };
    } else {
      usageStatsByItemId[itemId] = {
        ...current,
        activationCount: current.activationCount + 1,
        lastUsedAt: activatedAt
      };
    }
  }

  const activationHistory = [
    ...createActivationHistoryEntries(items, bundleName, activatedAt),
    ...settings.activationHistory
  ].slice(0, MAX_HISTORY_ENTRIES);

  return {
    ...settings,
    usageStatsByItemId,
    activationHistory
  };
}

export function recordActivityResults(
  settings: QuickPimSettings,
  input: {
    action: "activate" | "deactivate";
    items: ActivationItem[];
    response: ActivationResponse;
    requestedAt: string;
    completedAt: string;
    durationHours?: number;
    justification?: string;
    bundleName?: string;
    eventIdPrefix?: string;
    source?: ActivitySource;
  }
): QuickPimSettings {
  const itemsById = new Map(input.items.map((item) => [normalizeActivationItemId(item.id), item]));
  const entries = input.response.results.map((result): ActivityHistoryEntry => {
    const item = itemsById.get(normalizeActivationItemId(result.itemId));
    const historyResult: ActivityResult = result.success ? "success" : "failed";
    return {
      id: buildActivityHistoryEntryId(input.eventIdPrefix || input.completedAt, input.action, result.itemId, historyResult),
      action: input.action,
      result: historyResult,
      itemId: result.itemId,
      itemName: item?.displayName || result.itemName,
      itemType: item?.type || inferItemType(result.itemId),
      ...(item?.tenantId ? { tenantId: item.tenantId } : {}),
      scopeLabel: item?.scopeLabel,
      requestedAt: input.requestedAt,
      completedAt: input.completedAt,
      ...(input.durationHours && input.action === "activate" ? { durationHours: input.durationHours } : {}),
      ...(input.bundleName ? { bundleName: input.bundleName } : {}),
      ...(sanitizeUserJustification(input.justification) ? { justification: sanitizeUserJustification(input.justification) } : {}),
      ...(result.error ? { error: sanitizeErrorMessage(result.error) } : {}),
      ...(input.source?.installationId ? { sourceInstallationId: input.source.installationId } : {}),
      ...(input.source?.deviceName ? { sourceDeviceName: input.source.deviceName } : {})
    };
  });

  const entryIds = new Set(entries.map((entry) => entry.id));

  return {
    ...settings,
    activityHistory: [
      ...entries,
      ...settings.activityHistory.filter((entry) => !entryIds.has(entry.id))
    ]
      .sort((left, right) => (
        right.completedAt || right.requestedAt
      ).localeCompare(left.completedAt || left.requestedAt))
      .slice(0, settings.preferences.activityHistoryLimit || DEFAULT_SETTINGS.preferences.activityHistoryLimit)
  };
}

export function recordOperationActivity(
  settings: QuickPimSettings,
  input: {
    operationId: string;
    action: "activate" | "deactivate";
    items: ActivationItem[];
    response: ActivationResponse;
    requestedAt: string;
    completedAt: string;
    durationHours?: number;
    justification?: string;
    bundleName?: string;
    source?: ActivitySource;
  }
): QuickPimSettings {
  let updated = settings;
  if (input.action === "activate") {
    const existingIds = new Set(settings.activityHistory.map((entry) => entry.id));
    const itemsById = new Map(input.items.map((item) => [normalizeActivationItemId(item.id), item]));
    const newlyCompletedItems = input.response.results.flatMap((result) => {
      if (!result.success) return [];
      const eventId = buildActivityHistoryEntryId(input.operationId, input.action, result.itemId, "success");
      const item = itemsById.get(normalizeActivationItemId(result.itemId));
      return item && !existingIds.has(eventId) ? [item] : [];
    });
    updated = recordActivations(
      updated,
      newlyCompletedItems,
      input.completedAt,
      input.bundleName,
      input.source
    );
  }
  return recordActivityResults(updated, {
    action: input.action,
    items: input.items,
    response: input.response,
    requestedAt: input.requestedAt,
    completedAt: input.completedAt,
    durationHours: input.durationHours,
    justification: input.justification,
    bundleName: input.bundleName,
    eventIdPrefix: input.operationId,
    source: input.source
  });
}

export function buildActivityHistoryEntryId(
  eventIdPrefix: string,
  action: "activate" | "deactivate",
  itemId: string,
  result: ActivityResult
): string {
  return buildBoundedEventId(`${eventIdPrefix}:${action}:${itemId}:${result}`);
}

export function createActivationHistoryEntries(
  items: ActivationItem[],
  bundleName: string | undefined,
  activatedAt: string
): ActivationHistoryEntry[] {
  return items.map((item) => ({
    id: buildBoundedEventId(`${activatedAt}:${item.id}`),
    itemId: item.id,
    itemName: item.displayName,
    itemType: item.type,
    ...(item.tenantId ? { tenantId: item.tenantId } : {}),
    bundleName,
    activatedAt
  }));
}

function buildBoundedEventId(value: string): string {
  if (value.length <= MAX_ACTIVITY_EVENT_ID_LENGTH) return value;
  const suffix = stableTextHash(value);
  return `${value.slice(0, MAX_ACTIVITY_EVENT_ID_LENGTH - suffix.length - 1)}:${suffix}`;
}

function stableTextHash(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
}

export function expandBundle(bundle: QuickPimBundle, items: ActivationItem[]): BundleExpansion {
  const itemsById = new Map<string, ActivationItem>();
  for (const item of items) {
    for (const identity of getActivationItemIdentityCandidates(item)) {
      itemsById.set(normalizeActivationItemId(identity), item);
    }
    itemsById.set(normalizeActivationItemId(item.id), item);
  }
  const bundleItems = bundle.itemIds
    .map((itemId) => itemsById.get(normalizeActivationItemId(itemId)))
    .filter((item): item is ActivationItem => Boolean(item && item.status === "eligible"));

  return {
    items: bundleItems,
    durationHours: bundle.defaultDurationHours,
    justification: bundle.defaultJustification,
    ticketInfo: {}
  };
}

export function createBundleId(name: string): string {
  void name;
  return `bundle:${crypto.randomUUID()}`;
}

function sanitizeAliases(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }

  const entries: Array<readonly [string, string]> = [];
  for (const [key, alias] of Object.entries(value)) {
    const safeKey = sanitizeItemId(key);
    const safeAlias = sanitizeString(alias, MAX_ALIAS_LENGTH);
    if (!safeKey || !isSafeRecordKey(safeKey) || !safeAlias) continue;
    entries.push([safeKey, safeAlias] as const);
    if (entries.length >= MAX_ALIASES) break;
  }
  return Object.fromEntries(entries);
}

function sanitizeUsageStats(value: unknown): QuickPimSettings["usageStatsByItemId"] {
  if (!isRecord(value)) {
    return {};
  }

  const entries: Array<readonly [string, UsageStats]> = [];
  for (const [key, stats] of Object.entries(value)) {
    if (!isRecord(stats)) {
      continue;
    }
    const safeKey = sanitizeItemId(key);
    if (!safeKey || !isSafeRecordKey(safeKey)) {
      continue;
    }
    const activationCount = clampInteger(stats.activationCount, 0, 100000, 0);
    const lastUsedAt = sanitizeIsoTimestamp(stats.lastUsedAt);
    const byInstallationId = sanitizeInstallationUsageStats(stats.byInstallationId);
    const knownTotal = Object.values(byInstallationId).reduce((total, entry) => total + entry.activationCount, 0);
    const legacyActivationCount = clampInteger(
      stats.legacyActivationCount,
      0,
      100000,
      Math.max(0, activationCount - knownTotal)
    );
    const normalizedTotal = Math.min(100000, legacyActivationCount + knownTotal);
    entries.push([
      safeKey,
      {
        activationCount: normalizedTotal,
        ...(lastUsedAt ? { lastUsedAt } : {}),
        ...(legacyActivationCount ? { legacyActivationCount } : {}),
        ...(Object.keys(byInstallationId).length ? { byInstallationId } : {})
      }
    ] as const);
    if (entries.length >= MAX_ALIASES) break;
  }
  return Object.fromEntries(entries);
}

function sanitizeInstallationUsageStats(value: unknown): NonNullable<UsageStats["byInstallationId"]> {
  if (!isRecord(value)) return {};
  const entries: Array<readonly [string, NonNullable<UsageStats["byInstallationId"]>[string]]> = [];
  for (const [installationId, entry] of Object.entries(value)) {
    if (!isRecord(entry)) continue;
    const safeId = sanitizeString(installationId, 80);
    const activationCount = clampInteger(entry.activationCount, 0, 100000, 0);
    const lastUsedAt = sanitizeIsoTimestamp(entry.lastUsedAt);
    if (!safeId || !isSafeRecordKey(safeId) || !activationCount) continue;
    entries.push([safeId, { activationCount, ...(lastUsedAt ? { lastUsedAt } : {}) }] as const);
    if (entries.length >= 20) break;
  }
  return Object.fromEntries(entries);
}

function sanitizeFavoriteItemIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed || trimmed.length > MAX_ITEM_ID_LENGTH) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalizeActivationItemId(trimmed));
    if (result.length >= MAX_FAVORITES) break;
  }
  return result;
}

function sanitizePreferences(value: unknown): QuickPimSettings["preferences"] {
  const preferences = isRecord(value) ? value : {};
  const ignoredAt = sanitizeString(preferences.permissionWarningIgnoredAt, 64);
  const defaultSort = isSortMode(preferences.defaultSort) ? preferences.defaultSort : DEFAULT_SETTINGS.preferences.defaultSort;
  return {
    defaultDurationHours: clampNumber(preferences.defaultDurationHours, MIN_ACTIVATION_DURATION_HOURS, MAX_ACTIVATION_DURATION_HOURS, DEFAULT_SETTINGS.preferences.defaultDurationHours),
    defaultExtensionDurationHours: sanitizeExtensionDurationHours(preferences.defaultExtensionDurationHours),
    defaultSort,
    defaultSortDirection: isSortDirection(preferences.defaultSortDirection)
      ? preferences.defaultSortDirection
      : getDefaultSortDirection(defaultSort),
    recentJustificationLimit: clampInteger(preferences.recentJustificationLimit, 1, 20, DEFAULT_SETTINGS.preferences.recentJustificationLimit),
    activityHistoryLimit: clampInteger(preferences.activityHistoryLimit, 10, MAX_ACTIVITY_HISTORY_ENTRIES, DEFAULT_SETTINGS.preferences.activityHistoryLimit),
    darkMode: preferences.darkMode === true,
    showAssignedRoles: preferences.showAssignedRoles === true,
    showRemainingActivationTime: typeof preferences.showRemainingActivationTime === "boolean"
      ? preferences.showRemainingActivationTime
      : preferences.hideRemainingActivationTime !== true,
    showActivationCounters: preferences.showActivationCounters === true,
    showEnablementDetails: preferences.showEnablementDetails === true,
    showLastEnablementDate: preferences.showLastEnablementDate === true,
    backgroundPreRefreshEnabled: preferences.backgroundPreRefreshEnabled !== false,
    requestNotificationsEnabled: preferences.requestNotificationsEnabled === true,
    expiryReminderMinutes: sanitizeExpiryReminderMinutes(preferences.expiryReminderMinutes),
    enabledFeatures: sanitizeEnabledFeatures(preferences.enabledFeatures, preferences.hiddenPopupTabs),
    autoEnabledFeaturesInitialized: preferences.autoEnabledFeaturesInitialized === true,
    permissionWarningIgnored: preferences.permissionWarningIgnored === true,
    ...(ignoredAt ? { permissionWarningIgnoredAt: ignoredAt } : {})
  };
}

export function getEnabledRoleFeatures(settings: QuickPimSettings): Array<ActivationItem["type"]> {
  const enabled = new Set(settings.preferences.enabledFeatures || ALL_FEATURES);
  return ROLE_FEATURES.filter((feature): feature is ActivationItem["type"] => enabled.has(feature));
}

export function buildFeatureCacheKey(tokenCacheKey: string, enabledRoleFeatures: Array<ActivationItem["type"]>): string {
  const enabled = new Set(enabledRoleFeatures);
  const allRoleFeaturesEnabled = ROLE_FEATURES.every((feature) => enabled.has(feature)) && enabled.size === ROLE_FEATURES.length;
  return allRoleFeaturesEnabled ? tokenCacheKey : `${tokenCacheKey}|features:${enabledRoleFeatures.join(",") || "none"}`;
}

export function getAutoEnabledFeatures(items: ActivationItem[], preserveBundles = true): QuickPimFeature[] {
  const itemTypes = new Set(items.map((item) => item.type));
  const enabled: QuickPimFeature[] = ROLE_FEATURES.filter((feature) => itemTypes.has(feature));
  if (preserveBundles) {
    enabled.push("bundles");
  }
  return enabled.length ? enabled : preserveBundles ? ["bundles"] : [];
}

function sanitizeEnabledFeatures(value: unknown, legacyHiddenPopupTabs: unknown): QuickPimFeature[] {
  if (!Array.isArray(value)) {
    const hidden = new Set(sanitizeFeatureList(legacyHiddenPopupTabs));
    return ALL_FEATURES.filter((feature) => !hidden.has(feature));
  }

  const enabled = sanitizeFeatureList(value);
  return enabled.length ? enabled : [];
}

function sanitizeFeatureList(value: unknown): QuickPimFeature[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<QuickPimFeature>();
  const result: QuickPimFeature[] = [];
  for (const item of value) {
    if (!isQuickPimFeature(item) || seen.has(item)) continue;
    seen.add(item);
    result.push(item);
  }
  return result;
}

function sanitizeBundles(value: unknown): QuickPimBundle[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const bundles: QuickPimBundle[] = [];
  for (const bundle of value) {
    if (!isRecord(bundle)) {
      continue;
    }
    const name = sanitizeString(bundle.name, MAX_BUNDLE_NAME_LENGTH);
    if (!name) {
      continue;
    }
    const id = sanitizeString(bundle.id, MAX_ITEM_ID_LENGTH) || createBundleId(name);
    const itemIds = sanitizeStringList(bundle.itemIds, MAX_BUNDLE_ITEMS, MAX_ITEM_ID_LENGTH);
    if (!itemIds.length) {
      continue;
    }
    const defaultJustification = sanitizeUserJustification(bundle.defaultJustification);
    bundles.push({
      id,
      name,
      itemIds,
      defaultDurationHours: clampNumber(bundle.defaultDurationHours, MIN_ACTIVATION_DURATION_HOURS, MAX_ACTIVATION_DURATION_HOURS, DEFAULT_SETTINGS.preferences.defaultDurationHours),
      defaultJustification: defaultJustification && !isGenericJustification(defaultJustification) ? defaultJustification : undefined
    });
    if (bundles.length >= MAX_BUNDLES) break;
  }

  const seenIds = new Set<string>();
  return bundles.map((bundle) => {
    const normalizedId = bundle.id.toLowerCase();
    if (!seenIds.has(normalizedId)) {
      seenIds.add(normalizedId);
      return bundle;
    }
    const id = createBundleId(bundle.name);
    seenIds.add(id.toLowerCase());
    return { ...bundle, id };
  });
}

function sanitizeJustificationList(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    const safeItem = sanitizeUserJustification(item);
    const key = safeItem.toLowerCase();
    if (!safeItem || isGenericJustification(safeItem) || seen.has(key)) continue;
    seen.add(key);
    result.push(safeItem);
    if (result.length >= limit) break;
  }
  return result;
}

function sanitizeActivationHistory(value: unknown): ActivationHistoryEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const result: ActivationHistoryEntry[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      continue;
    }
    const id = sanitizeString(entry.id, MAX_ITEM_ID_LENGTH);
    const itemId = sanitizeItemId(entry.itemId);
    const itemName = sanitizeString(entry.itemName, MAX_ALIAS_LENGTH);
    const itemType = isActivationItemType(entry.itemType) ? entry.itemType : undefined;
    const activatedAt = sanitizeIsoTimestamp(entry.activatedAt);
    if (!id || !itemId || !itemName || !itemType || !activatedAt) {
      continue;
    }
    result.push({
      id,
      itemId,
      itemName,
      itemType,
      activatedAt,
      ...(sanitizeString(entry.tenantId, MAX_ITEM_ID_LENGTH) ? { tenantId: sanitizeString(entry.tenantId, MAX_ITEM_ID_LENGTH) } : {}),
      bundleName: sanitizeString(entry.bundleName, MAX_BUNDLE_NAME_LENGTH)
    });
  }
  return result
    .sort((left, right) => right.activatedAt.localeCompare(left.activatedAt))
    .slice(0, MAX_HISTORY_ENTRIES);
}

function sanitizeActivityHistory(
  value: unknown,
  legacyActivationHistory: unknown,
  preferences: unknown
): ActivityHistoryEntry[] {
  const limit = clampInteger(
    isRecord(preferences) ? preferences.activityHistoryLimit : undefined,
    10,
    MAX_ACTIVITY_HISTORY_ENTRIES,
    DEFAULT_SETTINGS.preferences.activityHistoryLimit
  );
  const source = Array.isArray(value) ? value : migrateActivationHistoryToActivity(legacyActivationHistory);

  const resultEntries: ActivityHistoryEntry[] = [];
  for (const entry of source) {
    if (!isRecord(entry)) {
      continue;
    }
    const id = sanitizeString(entry.id, MAX_ITEM_ID_LENGTH);
    const action = entry.action === "deactivate" ? "deactivate" : entry.action === "activate" ? "activate" : undefined;
    const result = entry.result === "failed" || entry.result === "skipped" || entry.result === "success" ? entry.result : undefined;
    const itemId = sanitizeItemId(entry.itemId);
    const itemName = sanitizeString(entry.itemName, MAX_ALIAS_LENGTH);
    const itemType = isActivationItemType(entry.itemType) ? entry.itemType : undefined;
    const requestedAt = sanitizeIsoTimestamp(entry.requestedAt);
    if (!id || !action || !result || !itemId || !itemName || !itemType || !requestedAt) {
      continue;
    }
    const durationHours = clampOptionalNumber(entry.durationHours, MIN_ACTIVATION_DURATION_HOURS, MAX_ACTIVATION_DURATION_HOURS);
    resultEntries.push({
      id,
      action,
      result,
      itemId,
      itemName,
      itemType,
      requestedAt,
      ...(sanitizeString(entry.tenantId, MAX_ITEM_ID_LENGTH) ? { tenantId: sanitizeString(entry.tenantId, MAX_ITEM_ID_LENGTH) } : {}),
      ...(sanitizeIsoTimestamp(entry.completedAt) ? { completedAt: sanitizeIsoTimestamp(entry.completedAt) } : {}),
      ...(sanitizeString(entry.scopeLabel, MAX_ALIAS_LENGTH) ? { scopeLabel: sanitizeString(entry.scopeLabel, MAX_ALIAS_LENGTH) } : {}),
      ...(durationHours ? { durationHours } : {}),
      ...(sanitizeString(entry.bundleName, MAX_BUNDLE_NAME_LENGTH) ? { bundleName: sanitizeString(entry.bundleName, MAX_BUNDLE_NAME_LENGTH) } : {}),
      ...(sanitizeUserJustification(entry.justification) ? { justification: sanitizeUserJustification(entry.justification) } : {}),
      ...(sanitizeString(entry.error, 260) ? { error: sanitizeErrorMessage(sanitizeString(entry.error, 260)) } : {}),
      ...(sanitizeString(entry.sourceInstallationId, 80) ? { sourceInstallationId: sanitizeString(entry.sourceInstallationId, 80) } : {}),
      ...(sanitizeString(entry.sourceDeviceName, 60) ? { sourceDeviceName: sanitizeString(entry.sourceDeviceName, 60) } : {})
    });
  }
  const byId = new Map<string, ActivityHistoryEntry>();
  for (const entry of resultEntries) {
    const current = byId.get(entry.id);
    if (!current || (entry.completedAt || entry.requestedAt) > (current.completedAt || current.requestedAt)) {
      byId.set(entry.id, entry);
    }
  }
  return [...byId.values()]
    .sort((left, right) => (
      right.completedAt || right.requestedAt
    ).localeCompare(left.completedAt || left.requestedAt))
    .slice(0, limit);
}

function latestIsoTimestamp(left: string | undefined, right: string | undefined): string | undefined {
  const safeLeft = sanitizeIsoTimestamp(left);
  const safeRight = sanitizeIsoTimestamp(right);
  if (!safeLeft) return safeRight;
  if (!safeRight) return safeLeft;
  return Date.parse(safeLeft) >= Date.parse(safeRight) ? safeLeft : safeRight;
}

function migrateActivationHistoryToActivity(value: unknown): ActivityHistoryEntry[] {
  return sanitizeActivationHistory(value).map((entry) => ({
    id: entry.id,
    action: "activate",
    result: "success",
    itemId: entry.itemId,
    itemName: entry.itemName,
    itemType: entry.itemType,
    ...(entry.tenantId ? { tenantId: entry.tenantId } : {}),
    requestedAt: entry.activatedAt,
    completedAt: entry.activatedAt,
    ...(entry.bundleName ? { bundleName: entry.bundleName } : {})
  }));
}

function sanitizeStringList(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    const safeItem = sanitizeItemId(item, maxLength);
    if (!safeItem) continue;
    const key = safeItem.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(safeItem);
    if (result.length >= maxItems) break;
  }
  return result;
}

function sanitizeItemId(value: unknown, maxLength = MAX_ITEM_ID_LENGTH): string {
  const safeItem = sanitizeString(value, maxLength);
  return safeItem ? normalizeActivationItemId(safeItem) : "";
}

function sanitizeIsoTimestamp(value: unknown, now = Date.now()): string | undefined {
  if (typeof value !== "string") return undefined;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0 || timestamp > now + MAX_TIMESTAMP_FUTURE_SKEW_MS) {
    return undefined;
  }
  return new Date(timestamp).toISOString();
}

function sanitizeString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  return trimmed.slice(0, maxLength);
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, numberValue));
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  return Math.round(clampNumber(value, min, max, fallback));
}

function clampOptionalNumber(value: unknown, min: number, max: number): number | undefined {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) {
    return undefined;
  }
  return Math.min(max, Math.max(min, numberValue));
}

function sanitizeExpiryReminderMinutes(value: unknown): number {
  const minutes = Number(value);
  return minutes === 5 || minutes === 15 || minutes === 30 || minutes === 60 ? minutes : 15;
}

function inferItemType(itemId: string): ActivationItem["type"] {
  const [type] = itemId.split(":");
  return isActivationItemType(type) ? type : "directoryRole";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isSortMode(value: unknown): value is SortMode {
  return value === "name" || value === "lastUsed" || value === "activationCount" || value === "scope";
}

function isSortDirection(value: unknown): value is SortDirection {
  return value === "ascending" || value === "descending";
}

function isQuickPimFeature(value: unknown): value is QuickPimFeature {
  return value === "directoryRole" || value === "pimGroup" || value === "azureRole" || value === "bundles";
}

function isActivationItemType(value: unknown): value is ActivationItem["type"] {
  return value === "directoryRole" || value === "azureRole" || value === "pimGroup";
}
