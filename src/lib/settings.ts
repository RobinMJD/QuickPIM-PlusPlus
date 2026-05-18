import type {
  ActivationHistoryEntry,
  ActivationItem,
  BundleExpansion,
  QuickPimBundle,
  QuickPimSettings,
  SortMode,
  TicketInfo
} from "./types";

export const SETTINGS_KEY = "quickPimSettings.v1";
const MAX_HISTORY_ENTRIES = 50;

export const DEFAULT_SETTINGS: QuickPimSettings = {
  version: 1,
  aliasesByItemId: {},
  savedJustifications: [],
  recentJustifications: [],
  bundles: [],
  usageStatsByItemId: {},
  activationHistory: [],
  preferences: {
    defaultDurationHours: 1,
    defaultSort: "name",
    recentJustificationLimit: 8
  }
};

export function mergeSettings(input: Partial<QuickPimSettings> | undefined): QuickPimSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...input,
    aliasesByItemId: { ...DEFAULT_SETTINGS.aliasesByItemId, ...(input?.aliasesByItemId || {}) },
    usageStatsByItemId: {
      ...DEFAULT_SETTINGS.usageStatsByItemId,
      ...(input?.usageStatsByItemId || {})
    },
    preferences: { ...DEFAULT_SETTINGS.preferences, ...(input?.preferences || {}) },
    savedJustifications: [...(input?.savedJustifications || [])],
    recentJustifications: [...(input?.recentJustifications || [])],
    bundles: [...(input?.bundles || [])],
    activationHistory: [...(input?.activationHistory || [])],
    version: 1
  };
}

export async function loadSettings(): Promise<QuickPimSettings> {
  const result = await chrome.storage.local.get(SETTINGS_KEY);
  return mergeSettings(result[SETTINGS_KEY] as Partial<QuickPimSettings> | undefined);
}

export async function saveSettings(settings: QuickPimSettings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: mergeSettings(settings) });
}

export function getDisplayName(item: ActivationItem, settings: QuickPimSettings): string {
  const alias = settings.aliasesByItemId[item.id]?.trim();
  return alias || item.displayName || item.sourceName || "Unknown";
}

export function getUsage(item: ActivationItem, settings: QuickPimSettings) {
  return settings.usageStatsByItemId[item.id] || { activationCount: 0 };
}

export function sortItems(
  items: ActivationItem[],
  settings: QuickPimSettings,
  sortMode: SortMode
): ActivationItem[] {
  const sortable = [...items];
  return sortable.sort((a, b) => {
    if (sortMode === "lastUsed") {
      const aDate = getUsage(a, settings).lastUsedAt || "";
      const bDate = getUsage(b, settings).lastUsedAt || "";
      return bDate.localeCompare(aDate) || getDisplayName(a, settings).localeCompare(getDisplayName(b, settings));
    }

    if (sortMode === "activationCount") {
      const diff = getUsage(b, settings).activationCount - getUsage(a, settings).activationCount;
      return diff || getDisplayName(a, settings).localeCompare(getDisplayName(b, settings));
    }

    if (sortMode === "type") {
      return a.type.localeCompare(b.type) || getDisplayName(a, settings).localeCompare(getDisplayName(b, settings));
    }

    if (sortMode === "scope") {
      return a.scopeLabel.localeCompare(b.scopeLabel) || getDisplayName(a, settings).localeCompare(getDisplayName(b, settings));
    }

    return getDisplayName(a, settings).localeCompare(getDisplayName(b, settings));
  });
}

export function addRecentJustification(settings: QuickPimSettings, justification: string): QuickPimSettings {
  const trimmed = justification.trim();
  if (!trimmed) {
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
  if (!trimmed) {
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
    .filter((item): item is ActivationItem => Boolean(item));
  const ticketInfo: TicketInfo = {};

  if (bundle.defaultTicketSystem) {
    ticketInfo.ticketSystem = bundle.defaultTicketSystem;
  }

  if (bundle.defaultTicketNumber) {
    ticketInfo.ticketNumber = bundle.defaultTicketNumber;
  }

  return {
    items: bundleItems,
    durationHours: bundle.defaultDurationHours,
    justification: bundle.defaultJustification,
    ticketInfo
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
