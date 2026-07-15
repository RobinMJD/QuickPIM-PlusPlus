import type { PopupRequestMode, PopupTab, SortMode } from "./types";
import type { QuickFilter } from "./popupModel";
import { MAX_ACTIVATION_DURATION_HOURS, MIN_ACTIVATION_DURATION_HOURS } from "./duration";
import { sanitizeUserJustification } from "./justifications";

export const POPUP_DRAFT_KEY = "quickPimPopupDraft.v1";

const POPUP_DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SELECTED_IDS = 100;
const MAX_ITEM_ID_LENGTH = 256;
const MAX_SEARCH_LENGTH = 120;
const MAX_TICKET_FIELD_LENGTH = 120;
const MAX_FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1000;
let popupDraftMutationQueue: Promise<void> = Promise.resolve();

const POPUP_TABS: PopupTab[] = ["directoryRole", "pimGroup", "azureRole", "bundles"];
const SORT_MODES: SortMode[] = ["name", "lastUsed", "activationCount", "type", "scope"];
const QUICK_FILTERS: QuickFilter[] = ["favorites", "eligible", "active", "requiresJustification"];

export interface PopupDraft {
  updatedAt: number;
  tab: PopupTab;
  search: string;
  sortMode: SortMode;
  quickFilters: QuickFilter[];
  selectedIds: string[];
  durationHours: number;
  justification: string;
  ticketSystem: string;
  ticketNumber: string;
  isActivationReviewOpen: boolean;
  requestMode?: PopupRequestMode;
}

export type PopupDraftInput = Omit<PopupDraft, "updatedAt" | "quickFilters"> & { updatedAt?: number; quickFilters?: QuickFilter[] };

export async function loadPopupDraft(now = Date.now()): Promise<PopupDraft | undefined> {
  const result = await chrome.storage.local.get(POPUP_DRAFT_KEY);
  return sanitizePopupDraft(result[POPUP_DRAFT_KEY], now);
}

export async function savePopupDraft(draft: PopupDraftInput, now = Date.now()): Promise<void> {
  const safeDraft = sanitizePopupDraft({ ...draft, updatedAt: now }, now);
  return enqueuePopupDraftMutation(async () => {
    if (!safeDraft || !hasPopupDraftContent(safeDraft)) {
      await chrome.storage.local.remove(POPUP_DRAFT_KEY);
      return;
    }
    await chrome.storage.local.set({ [POPUP_DRAFT_KEY]: safeDraft });
  });
}

export async function clearPopupDraft(): Promise<void> {
  return enqueuePopupDraftMutation(() => chrome.storage.local.remove(POPUP_DRAFT_KEY));
}

export function sanitizePopupDraft(value: unknown, now = Date.now()): PopupDraft | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const updatedAt = typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt) ? value.updatedAt : 0;
  if (!updatedAt || now - updatedAt > POPUP_DRAFT_TTL_MS || updatedAt - now > MAX_FUTURE_CLOCK_SKEW_MS) {
    return undefined;
  }

  const selectedIds = sanitizeSelectedIds(value.selectedIds);
  const draft: PopupDraft = {
    updatedAt,
    tab: isPopupTab(value.tab) ? value.tab : "directoryRole",
    search: sanitizeString(value.search, MAX_SEARCH_LENGTH),
    sortMode: isSortMode(value.sortMode) ? value.sortMode : "name",
    quickFilters: sanitizeQuickFilters(value.quickFilters),
    selectedIds,
    durationHours: sanitizeDuration(value.durationHours),
    justification: sanitizeUserJustification(value.justification),
    ticketSystem: sanitizeString(value.ticketSystem, MAX_TICKET_FIELD_LENGTH),
    ticketNumber: sanitizeString(value.ticketNumber, MAX_TICKET_FIELD_LENGTH),
    isActivationReviewOpen: Boolean(value.isActivationReviewOpen && selectedIds.length),
    ...(isPopupRequestMode(value.requestMode) ? { requestMode: value.requestMode } : {})
  };

  return hasPopupDraftContent(draft) ? draft : undefined;
}

export function hasPopupDraftContent(draft: PopupDraftInput): boolean {
  return Boolean(
    draft.selectedIds.length ||
      draft.search.trim() ||
      draft.tab !== "directoryRole" ||
      draft.sortMode !== "name" ||
      draft.quickFilters?.length
  );
}

function sanitizeQuickFilters(value: unknown): QuickFilter[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.filter((item): item is QuickFilter => typeof item === "string" && QUICK_FILTERS.includes(item as QuickFilter)))];
}

function sanitizeSelectedIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    const safeItem = sanitizeString(item, MAX_ITEM_ID_LENGTH);
    if (!safeItem || seen.has(safeItem.toLowerCase())) {
      continue;
    }
    seen.add(safeItem.toLowerCase());
    result.push(safeItem);
    if (result.length >= MAX_SELECTED_IDS) {
      break;
    }
  }
  return result;
}

function sanitizeDuration(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return MIN_ACTIVATION_DURATION_HOURS;
  }
  return Math.min(
    MAX_ACTIVATION_DURATION_HOURS,
    Math.max(MIN_ACTIVATION_DURATION_HOURS, Math.round(numeric * 2) / 2)
  );
}

function enqueuePopupDraftMutation(operation: () => Promise<void>): Promise<void> {
  const result = popupDraftMutationQueue.then(operation);
  popupDraftMutationQueue = result.catch(() => undefined);
  return result;
}

function sanitizeString(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function isPopupTab(value: unknown): value is PopupTab {
  return typeof value === "string" && POPUP_TABS.includes(value as PopupTab);
}

function isSortMode(value: unknown): value is SortMode {
  return typeof value === "string" && SORT_MODES.includes(value as SortMode);
}

function isPopupRequestMode(value: unknown): value is PopupRequestMode {
  return value === "activate" || value === "deactivate";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
