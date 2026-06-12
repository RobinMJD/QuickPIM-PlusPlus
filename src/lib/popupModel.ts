import { CLAIMS_CHALLENGE_MESSAGE, isClaimsChallengeMessage } from "./apiErrors";
import type { ActivationItem, ActivationResult, ActivationStatus, PopupTab, RoleTab, TokenStatusEntry } from "./types";
export type { PopupTab, RoleTab } from "./types";

export const ENTRA_PORTAL_URLS: Record<RoleTab, string> = {
  directoryRole:
    "https://entra.microsoft.com/?feature.msaljs=true#view/Microsoft_Azure_PIMCommon/ActivationMenuBlade/~/aadmigratedroles/provider/azurerbac",
  pimGroup:
    "https://entra.microsoft.com/?feature.msaljs=true#view/Microsoft_Azure_PIMCommon/ActivationMenuBlade/~/aadgroup/provider/azurerbac",
  azureRole:
    "https://entra.microsoft.com/?feature.msaljs=true#view/Microsoft_Azure_PIMCommon/ActivationMenuBlade/~/azurerbac/provider/azurerbac"
};

export const ENTRA_GRAPH_BOOTSTRAP_URLS: Record<Exclude<RoleTab, "azureRole">, string> = {
  directoryRole:
    "https://entra.microsoft.com/?feature.msaljs=true#view/Microsoft_AAD_UsersAndTenants/UserManagementMenuBlade/~/AllUsers",
  pimGroup:
    "https://entra.microsoft.com/?feature.msaljs=true#view/Microsoft_AAD_IAM/GroupsManagementMenuBlade/~/AllGroups"
};

export function getPortalUrlForTab(tab: PopupTab): string | undefined {
  if (tab === "directoryRole" || tab === "pimGroup" || tab === "azureRole") {
    return ENTRA_PORTAL_URLS[tab];
  }
  return undefined;
}

export function tokenStatusText(label: string, status: TokenStatusEntry | undefined): string {
  if (!status?.hasToken) {
    return `${label} token missing`;
  }

  if (status.isExpired) {
    return `${label} expired. Refresh in portal.`;
  }

  const age = status.tokenAge ?? 0;
  return `${label} ready (${age} min ago)`;
}

export function formatLoadMessages(messages: string[]): string[] {
  const seen = new Set<string>();
  return messages
    .map((message) => formatLoadMessage(message))
    .filter((message) => {
      if (!message || seen.has(message)) {
        return false;
      }
      seen.add(message);
      return true;
    });
}

export function getRemainingSelectedIdsAfterActivationResults(
  selectedIds: Iterable<string>,
  results: ActivationResult[]
): Set<string> {
  const successfulIds = new Set(results.filter((result) => result.success).map((result) => result.itemId));
  return new Set([...selectedIds].filter((itemId) => !successfulIds.has(itemId)));
}

export function getDurationOptions(items: ActivationItem[]): Array<{ value: number; label: string }> {
  const activatableItems = getActivatableItems(items);
  if (!activatableItems.length) {
    return [];
  }

  const maxDurationHours = getSelectedMaxDurationHours(activatableItems);
  const values = maxDurationHours ? [...BASE_DURATION_VALUES, maxDurationHours] : BASE_DURATION_VALUES;
  return [...new Set(values)]
    .filter((value) => !maxDurationHours || value <= maxDurationHours)
    .sort((a, b) => a - b)
    .map((value) => ({ value, label: formatDurationLabel(value) }));
}

export function coerceDurationForItems(durationHours: number, items: ActivationItem[]): number {
  const options = getDurationOptions(items);
  if (!options.length) {
    return durationHours;
  }

  if (options.some((option) => option.value === durationHours)) {
    return durationHours;
  }

  return [...options].reverse().find((option) => option.value <= durationHours)?.value || options[0].value;
}

const BASE_DURATION_VALUES = [0.5, 1, 2, 4, 8, 12, 24];

export const DEFAULT_DURATION_OPTIONS = BASE_DURATION_VALUES.map((value) => ({
  value,
  label: formatDurationLabel(value)
}));

function getSelectedMaxDurationHours(items: ActivationItem[]): number | undefined {
  const maximums = items
    .map((item) => item.activationRequirements?.maxDurationHours)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);
  return maximums.length ? Math.min(...maximums) : undefined;
}

function formatDurationLabel(value: number): string {
  if (value < 1) {
    return `${Math.round(value * 60)} minutes`;
  }

  return `${value} hour${value === 1 ? "" : "s"}`;
}

export function tokenStatusTone(status: TokenStatusEntry | undefined): "ok" | "warn" {
  return status?.hasToken && !status.isExpired ? "ok" : "warn";
}

export function getActivationRequirements(items: ActivationItem[]) {
  const activatableItems = getActivatableItems(items);
  return {
    needsJustification: activatableItems.some((item) => item.activationRequirements?.justification !== false),
    needsTicket: activatableItems.some((item) => item.activationRequirements?.ticket === true)
  };
}

export function tabLabel(tab: PopupTab): string {
  const labels: Record<PopupTab, string> = {
    directoryRole: "Entra Roles",
    pimGroup: "PIM Groups",
    azureRole: "Azure Roles",
    bundles: "Bundles"
  };
  return labels[tab];
}

export function mergeEligibleWithActive(
  eligibleItems: ActivationItem[],
  activeItems: ActivationItem[],
  options: { includeActiveOnly?: boolean } = {}
): ActivationItem[] {
  const activeById = new Map<string, ActivationItem>();
  for (const item of activeItems) {
    const current = activeById.get(item.id);
    if (!current || item.status === "active" || current.status !== "active") {
      activeById.set(item.id, item);
    }
  }
  const merged = eligibleItems.map((item) => {
    const activeItem = activeById.get(item.id);
    const activationRequirements = {
      ...item.activationRequirements,
      ...activeItem?.activationRequirements
    };
    return activeItem
      ? {
          ...item,
          status: activeItem.status,
          activeUntil: activeItem.activeUntil || item.activeUntil,
          ...(Object.keys(activationRequirements).length ? { activationRequirements } : {})
        }
      : item;
  });

  if (!options.includeActiveOnly) {
    return merged;
  }

  const mergedIds = new Set(merged.map((item) => item.id));
  const activeOnlyItems = activeItems.filter((item) => !mergedIds.has(item.id));
  return [...merged, ...activeOnlyItems];
}

export function getActivatableItems(items: ActivationItem[]): ActivationItem[] {
  return items.filter((item) => item.status === "eligible");
}

export function getDeactivatableItems(items: ActivationItem[]): ActivationItem[] {
  return items.filter((item) => item.status === "active");
}

export function isHighPrivilegeItem(item: ActivationItem): boolean {
  return item.isPrivileged === true;
}

export function getActiveStatusTitle(item: ActivationItem, now = Date.now()): string | undefined {
  if (item.status !== "active" || !item.activeUntil) {
    return undefined;
  }
  const activeUntilMs = new Date(item.activeUntil).getTime();
  if (!Number.isFinite(activeUntilMs)) {
    return undefined;
  }
  const activeUntil = item.activeUntil.replace("T", " ").slice(0, 16);
  const remaining = formatRemainingTime(activeUntilMs - now);
  return remaining ? `Active until ${activeUntil} (${remaining} remaining)` : `Active until ${activeUntil}`;
}

export function getActivationStatusTitle(item: ActivationItem, now = Date.now()): string | undefined {
  if (item.status === "pendingApproval") {
    return item.activationRequirements?.approval
      ? "Activation request is waiting for approval."
      : "Activation request is pending.";
  }
  return getActiveStatusTitle(item, now);
}

export function formatActivationStatusLabel(status: ActivationStatus): string {
  if (status === "pendingApproval") {
    return "Pending approval";
  }
  return status;
}

function formatRemainingTime(remainingMs: number): string {
  const totalMinutes = Math.max(0, Math.ceil(remainingMs / 60000));
  if (totalMinutes <= 0) {
    return "less than 1 minute";
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (!hours) {
    return `about ${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  if (!minutes) {
    return `about ${hours} hour${hours === 1 ? "" : "s"}`;
  }
  return `about ${hours} hour${hours === 1 ? "" : "s"} ${minutes} minute${minutes === 1 ? "" : "s"}`;
}

function formatLoadMessage(message: string): string {
  const trimmed = message.trim();
  if (!trimmed) {
    return "";
  }

  const parsed = parseJsonMessage(trimmed);
  const messageText = getParsedMessageText(parsed) || trimmed;
  const missingScopes = extractMissingPermissionScopes(messageText) || extractMissingPermissionScopes(trimmed);
  const errorCode = typeof parsed?.errorCode === "string" ? parsed.errorCode : undefined;

  if (isClaimsChallengeMessage(messageText) || isClaimsChallengeMessage(trimmed)) {
    return CLAIMS_CHALLENGE_MESSAGE;
  }

  if (isTokenExpiryMessage(messageText)) {
    return "Captured token expired. Refresh in portal.";
  }

  if (missingScopes || errorCode === "PermissionScopeNotGranted" || trimmed.includes("PermissionScopeNotGranted")) {
    return formatPermissionMessage(missingScopes);
  }

  if (parsed && messageText !== trimmed) {
    return messageText;
  }

  return trimmed;
}

function isTokenExpiryMessage(message: string): boolean {
  return /access token expiry UTC time/i.test(message) || /token (has )?expired/i.test(message);
}

function formatPermissionMessage(missingScopes: string | undefined): string {
  if (missingScopes?.includes("AzureADGroup")) {
    return "PIM Groups access is limited in the captured portal token. Use Access Setup to refresh portal access.";
  }

  return `Microsoft Graph access is limited in the captured portal token${missingScopes ? `: ${missingScopes}` : "."}`;
}

function parseJsonMessage(message: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(message);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function getParsedMessageText(parsed: Record<string, unknown> | undefined): string | undefined {
  if (!parsed) {
    return undefined;
  }

  if (typeof parsed.message === "string") {
    return parsed.message;
  }

  const nestedError = parsed.error;
  if (nestedError && typeof nestedError === "object" && !Array.isArray(nestedError)) {
    const nestedMessage = (nestedError as Record<string, unknown>).message;
    return typeof nestedMessage === "string" ? nestedMessage : undefined;
  }

  return undefined;
}

function extractMissingPermissionScopes(message: string): string | undefined {
  const match = message.match(/missing permission scopes?\s+(.+)/i);
  if (!match?.[1]) {
    return undefined;
  }

  const scopes = match[1]
    .replace(/\s*\[[\s\S]*$/, "")
    .replace(/[."'}\]]+$/g, "")
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);

  return scopes.length ? scopes.join(", ") : undefined;
}
