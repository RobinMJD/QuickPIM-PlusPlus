import type {
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
  SortMode
} from "./types";
import { getReferenceDisplayName, getReferenceScopeLabel } from "./referenceData";
import { isGenericJustification } from "./justifications";
import { sanitizeErrorMessage } from "./security";

export const SETTINGS_KEY = "quickPimSettings.v1";
const MAX_HISTORY_ENTRIES = 50;
const MAX_ACTIVITY_HISTORY_ENTRIES = 200;
const MAX_ALIASES = 300;
const MAX_FAVORITES = 300;
const MAX_ALIAS_LENGTH = 120;
const MAX_ITEM_ID_LENGTH = 256;
const MAX_JUSTIFICATION_LENGTH = 1024;
const MAX_SAVED_JUSTIFICATIONS = 100;
const MAX_BUNDLES = 50;
const MAX_BUNDLE_ITEMS = 100;
const MAX_BUNDLE_NAME_LENGTH = 80;
const MIN_DURATION_HOURS = 0.5;
const MAX_DURATION_HOURS = 24;
export const ROLE_FEATURES: Array<ActivationItem["type"]> = ["directoryRole", "pimGroup", "azureRole"];
export const ALL_FEATURES: QuickPimFeature[] = [...ROLE_FEATURES, "bundles"];

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
    defaultSort: "name",
    recentJustificationLimit: 8,
    activityHistoryLimit: 100,
    darkMode: false,
    showActivationCounters: false,
    showLastEnablementDate: false,
    showAdvancedSettings: false,
    backgroundPreRefreshEnabled: true,
    enabledFeatures: ALL_FEATURES,
    autoEnabledFeaturesInitialized: false,
    permissionWarningIgnored: false
  }
};

export function mergeSettings(input: Partial<QuickPimSettings> | undefined): QuickPimSettings {
  const source = isRecord(input) ? input : {};
  return {
    ...DEFAULT_SETTINGS,
    aliasesByItemId: sanitizeAliases(source.aliasesByItemId),
    favoriteItemIds: sanitizeFavoriteItemIds(source.favoriteItemIds),
    usageStatsByItemId: sanitizeUsageStats(source.usageStatsByItemId),
    preferences: sanitizePreferences(source.preferences),
    savedJustifications: sanitizeJustificationList(source.savedJustifications, MAX_SAVED_JUSTIFICATIONS),
    recentJustifications: sanitizeJustificationList(source.recentJustifications, 20),
    bundles: sanitizeBundles(source.bundles),
    activityHistory: sanitizeActivityHistory(source.activityHistory, source.activationHistory, source.preferences),
    activationHistory: sanitizeActivationHistory(source.activationHistory),
    version: 2
  };
}

export async function loadSettings(): Promise<QuickPimSettings> {
  const result = await chrome.storage.local.get(SETTINGS_KEY);
  return mergeSettings(result[SETTINGS_KEY] as Partial<QuickPimSettings> | undefined);
}

export async function saveSettings(settings: QuickPimSettings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: mergeSettings(settings) });
}

export function getDisplayName(
  item: ActivationItem,
  settings: QuickPimSettings,
  referenceData?: ReferenceDataCache
): string {
  const alias = settings.aliasesByItemId[item.id]?.trim();
  return alias || getReferenceDisplayName(item, referenceData) || item.displayName || item.sourceName || "Unknown";
}

export function getScopeLabel(item: ActivationItem, referenceData?: ReferenceDataCache): string {
  return getReferenceScopeLabel(item, referenceData) || item.scopeLabel || "Scope";
}

export function getUsage(item: ActivationItem, settings: QuickPimSettings) {
  return settings.usageStatsByItemId[item.id] || { activationCount: 0 };
}

export function sortItems(
  items: ActivationItem[],
  settings: QuickPimSettings,
  sortMode: SortMode,
  referenceData?: ReferenceDataCache
): ActivationItem[] {
  const sortable = [...items];
  const favoriteItemIds = new Set(settings.favoriteItemIds || []);
  return sortable.sort((a, b) => {
    const favoriteDiff = Number(favoriteItemIds.has(b.id)) - Number(favoriteItemIds.has(a.id));
    if (favoriteDiff) {
      return favoriteDiff;
    }

    if (sortMode === "lastUsed") {
      const aDate = getUsage(a, settings).lastUsedAt || "";
      const bDate = getUsage(b, settings).lastUsedAt || "";
      return bDate.localeCompare(aDate) || getDisplayName(a, settings, referenceData).localeCompare(getDisplayName(b, settings, referenceData));
    }

    if (sortMode === "activationCount") {
      const diff = getUsage(b, settings).activationCount - getUsage(a, settings).activationCount;
      return diff || getDisplayName(a, settings, referenceData).localeCompare(getDisplayName(b, settings, referenceData));
    }

    if (sortMode === "type") {
      return a.type.localeCompare(b.type) || getDisplayName(a, settings, referenceData).localeCompare(getDisplayName(b, settings, referenceData));
    }

    if (sortMode === "scope") {
      return getScopeLabel(a, referenceData).localeCompare(getScopeLabel(b, referenceData)) || getDisplayName(a, settings, referenceData).localeCompare(getDisplayName(b, settings, referenceData));
    }

    return getDisplayName(a, settings, referenceData).localeCompare(getDisplayName(b, settings, referenceData));
  });
}

export function addRecentJustification(settings: QuickPimSettings, justification: string): QuickPimSettings {
  const trimmed = justification.trim();
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
  const trimmed = justification.trim();
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
  bundleName?: string
): QuickPimSettings {
  const usageStatsByItemId = { ...settings.usageStatsByItemId };

  for (const item of items) {
    const current = usageStatsByItemId[item.id] || { activationCount: 0 };
    usageStatsByItemId[item.id] = {
      activationCount: current.activationCount + 1,
      lastUsedAt: activatedAt
    };
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
  }
): QuickPimSettings {
  const itemsById = new Map(input.items.map((item) => [item.id, item]));
  const entries = input.response.results.map((result): ActivityHistoryEntry => {
    const item = itemsById.get(result.itemId);
    const historyResult: ActivityResult = result.success ? "success" : "failed";
    return {
      id: `${input.completedAt}:${input.action}:${result.itemId}:${historyResult}`,
      action: input.action,
      result: historyResult,
      itemId: result.itemId,
      itemName: item?.displayName || result.itemName,
      itemType: item?.type || inferItemType(result.itemId),
      scopeLabel: item?.scopeLabel,
      requestedAt: input.requestedAt,
      completedAt: input.completedAt,
      ...(input.durationHours && input.action === "activate" ? { durationHours: input.durationHours } : {}),
      ...(input.bundleName ? { bundleName: input.bundleName } : {}),
      ...(input.justification?.trim() ? { justification: sanitizeString(input.justification, MAX_JUSTIFICATION_LENGTH) } : {}),
      ...(result.error ? { error: sanitizeErrorMessage(result.error) } : {})
    };
  });

  return {
    ...settings,
    activityHistory: [
      ...entries,
      ...settings.activityHistory
    ].slice(0, settings.preferences.activityHistoryLimit || DEFAULT_SETTINGS.preferences.activityHistoryLimit)
  };
}

export function createActivationHistoryEntries(
  items: ActivationItem[],
  bundleName: string | undefined,
  activatedAt: string
): ActivationHistoryEntry[] {
  return items.map((item) => ({
    id: `${activatedAt}:${item.id}`,
    itemId: item.id,
    itemName: item.displayName,
    itemType: item.type,
    bundleName,
    activatedAt
  }));
}

export function expandBundle(bundle: QuickPimBundle, items: ActivationItem[]): BundleExpansion {
  const bundleItems = bundle.itemIds
    .map((itemId) => items.find((item) => item.id === itemId))
    .filter((item): item is ActivationItem => Boolean(item && item.status === "eligible"));

  return {
    items: bundleItems,
    durationHours: bundle.defaultDurationHours,
    justification: bundle.defaultJustification,
    ticketInfo: {}
  };
}

export function createBundleId(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
  return `bundle:${slug || crypto.randomUUID()}`;
}

function sanitizeAliases(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }

  const entries = Object.entries(value)
    .slice(0, MAX_ALIASES)
    .flatMap(([key, alias]) => {
      const safeKey = sanitizeString(key, MAX_ITEM_ID_LENGTH);
      const safeAlias = sanitizeString(alias, MAX_ALIAS_LENGTH);
      return safeKey && safeAlias ? [[safeKey, safeAlias] as const] : [];
    });
  return Object.fromEntries(entries);
}

function sanitizeUsageStats(value: unknown): QuickPimSettings["usageStatsByItemId"] {
  if (!isRecord(value)) {
    return {};
  }

  const entries = Object.entries(value)
    .slice(0, MAX_ALIASES)
    .flatMap(([key, stats]) => {
      if (!isRecord(stats)) {
        return [];
      }
      const safeKey = sanitizeString(key, MAX_ITEM_ID_LENGTH);
      if (!safeKey) {
        return [];
      }
      const activationCount = clampInteger(stats.activationCount, 0, 100000, 0);
      const lastUsedAt = sanitizeString(stats.lastUsedAt, 64);
      return [
        [
          safeKey,
          {
            activationCount,
            ...(lastUsedAt ? { lastUsedAt } : {})
          }
        ] as const
      ];
    });
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
    result.push(trimmed);
    if (result.length >= MAX_FAVORITES) break;
  }
  return result;
}

function sanitizePreferences(value: unknown): QuickPimSettings["preferences"] {
  const preferences = isRecord(value) ? value : {};
  const ignoredAt = sanitizeString(preferences.permissionWarningIgnoredAt, 64);
  return {
    defaultDurationHours: clampNumber(preferences.defaultDurationHours, MIN_DURATION_HOURS, MAX_DURATION_HOURS, DEFAULT_SETTINGS.preferences.defaultDurationHours),
    defaultSort: isSortMode(preferences.defaultSort) ? preferences.defaultSort : DEFAULT_SETTINGS.preferences.defaultSort,
    recentJustificationLimit: clampInteger(preferences.recentJustificationLimit, 1, 20, DEFAULT_SETTINGS.preferences.recentJustificationLimit),
    activityHistoryLimit: clampInteger(preferences.activityHistoryLimit, 10, MAX_ACTIVITY_HISTORY_ENTRIES, DEFAULT_SETTINGS.preferences.activityHistoryLimit),
    darkMode: preferences.darkMode === true,
    showActivationCounters: preferences.showActivationCounters === true,
    showLastEnablementDate: preferences.showLastEnablementDate === true,
    showAdvancedSettings: preferences.showAdvancedSettings === true,
    backgroundPreRefreshEnabled: preferences.backgroundPreRefreshEnabled !== false,
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
  const itemTypes = new Set(items.filter((item) => item.status === "eligible").map((item) => item.type));
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

  return value.slice(0, MAX_BUNDLES).flatMap((bundle) => {
    if (!isRecord(bundle)) {
      return [];
    }
    const name = sanitizeString(bundle.name, MAX_BUNDLE_NAME_LENGTH);
    if (!name) {
      return [];
    }
    const id = sanitizeString(bundle.id, MAX_ITEM_ID_LENGTH) || createBundleId(name);
    const itemIds = sanitizeStringList(bundle.itemIds, MAX_BUNDLE_ITEMS, MAX_ITEM_ID_LENGTH);
    const defaultJustification = sanitizeString(bundle.defaultJustification, MAX_JUSTIFICATION_LENGTH);
    return [
      {
        id,
        name,
        itemIds,
        defaultDurationHours: clampNumber(bundle.defaultDurationHours, MIN_DURATION_HOURS, MAX_DURATION_HOURS, DEFAULT_SETTINGS.preferences.defaultDurationHours),
        defaultJustification: defaultJustification && !isGenericJustification(defaultJustification) ? defaultJustification : undefined
      }
    ];
  });
}

function sanitizeJustificationList(value: unknown, limit: number): string[] {
  return sanitizeStringList(value, limit, MAX_JUSTIFICATION_LENGTH).filter((item) => !isGenericJustification(item));
}

function sanitizeActivationHistory(value: unknown): ActivationHistoryEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.slice(0, MAX_HISTORY_ENTRIES).flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }
    const id = sanitizeString(entry.id, MAX_ITEM_ID_LENGTH);
    const itemId = sanitizeString(entry.itemId, MAX_ITEM_ID_LENGTH);
    const itemName = sanitizeString(entry.itemName, MAX_ALIAS_LENGTH);
    const itemType = isActivationItemType(entry.itemType) ? entry.itemType : undefined;
    const activatedAt = sanitizeString(entry.activatedAt, 64);
    if (!id || !itemId || !itemName || !itemType || !activatedAt) {
      return [];
    }
    return [
      {
        id,
        itemId,
        itemName,
        itemType,
        activatedAt,
        bundleName: sanitizeString(entry.bundleName, MAX_BUNDLE_NAME_LENGTH)
      }
    ];
  });
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

  return source.slice(0, limit).flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }
    const id = sanitizeString(entry.id, MAX_ITEM_ID_LENGTH);
    const action = entry.action === "deactivate" ? "deactivate" : entry.action === "activate" ? "activate" : undefined;
    const result = entry.result === "failed" || entry.result === "skipped" || entry.result === "success" ? entry.result : undefined;
    const itemId = sanitizeString(entry.itemId, MAX_ITEM_ID_LENGTH);
    const itemName = sanitizeString(entry.itemName, MAX_ALIAS_LENGTH);
    const itemType = isActivationItemType(entry.itemType) ? entry.itemType : undefined;
    const requestedAt = sanitizeString(entry.requestedAt, 64);
    if (!id || !action || !result || !itemId || !itemName || !itemType || !requestedAt) {
      return [];
    }
    const durationHours = clampOptionalNumber(entry.durationHours, MIN_DURATION_HOURS, MAX_DURATION_HOURS);
    return [
      {
        id,
        action,
        result,
        itemId,
        itemName,
        itemType,
        requestedAt,
        ...(sanitizeString(entry.completedAt, 64) ? { completedAt: sanitizeString(entry.completedAt, 64) } : {}),
        ...(sanitizeString(entry.scopeLabel, MAX_ALIAS_LENGTH) ? { scopeLabel: sanitizeString(entry.scopeLabel, MAX_ALIAS_LENGTH) } : {}),
        ...(durationHours ? { durationHours } : {}),
        ...(sanitizeString(entry.bundleName, MAX_BUNDLE_NAME_LENGTH) ? { bundleName: sanitizeString(entry.bundleName, MAX_BUNDLE_NAME_LENGTH) } : {}),
        ...(sanitizeString(entry.justification, MAX_JUSTIFICATION_LENGTH) ? { justification: sanitizeString(entry.justification, MAX_JUSTIFICATION_LENGTH) } : {}),
        ...(sanitizeString(entry.error, 260) ? { error: sanitizeErrorMessage(sanitizeString(entry.error, 260)) } : {})
      }
    ];
  });
}

function migrateActivationHistoryToActivity(value: unknown): ActivityHistoryEntry[] {
  return sanitizeActivationHistory(value).map((entry) => ({
    id: entry.id,
    action: "activate",
    result: "success",
    itemId: entry.itemId,
    itemName: entry.itemName,
    itemType: entry.itemType,
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
    const safeItem = sanitizeString(item, maxLength);
    if (!safeItem) continue;
    const key = safeItem.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(safeItem);
    if (result.length >= maxItems) break;
  }
  return result;
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

function inferItemType(itemId: string): ActivationItem["type"] {
  const [type] = itemId.split(":");
  return isActivationItemType(type) ? type : "directoryRole";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isSortMode(value: unknown): value is SortMode {
  return value === "name" || value === "lastUsed" || value === "activationCount" || value === "type" || value === "scope";
}

function isQuickPimFeature(value: unknown): value is QuickPimFeature {
  return value === "directoryRole" || value === "pimGroup" || value === "azureRole" || value === "bundles";
}

function isActivationItemType(value: unknown): value is ActivationItem["type"] {
  return value === "directoryRole" || value === "azureRole" || value === "pimGroup";
}
