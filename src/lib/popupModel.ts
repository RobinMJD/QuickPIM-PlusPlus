import type { ActivationItem, TokenStatusEntry } from "./types";

export type RoleTab = "directoryRole" | "pimGroup" | "azureRole";
export type PopupTab = RoleTab | "active" | "bundles";

export const ENTRA_PORTAL_URLS: Record<RoleTab, string> = {
  directoryRole:
    "https://entra.microsoft.com/?feature.msaljs=true#view/Microsoft_Azure_PIMCommon/ActivationMenuBlade/~/aadmigratedroles/provider/azurerbac",
  pimGroup:
    "https://entra.microsoft.com/?feature.msaljs=true#view/Microsoft_Azure_PIMCommon/ActivationMenuBlade/~/aadgroup/provider/azurerbac",
  azureRole:
    "https://entra.microsoft.com/?feature.msaljs=true#view/Microsoft_Azure_PIMCommon/ActivationMenuBlade/~/azurerbac/provider/azurerbac"
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

export function getDurationOptions(items: ActivationItem[]): Array<{ value: number; label: string }> {
  if (!items.length) {
    return [];
  }

  const maxDurationHours = getSelectedMaxDurationHours(items);
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
  return {
    needsJustification: items.some((item) => item.activationRequirements?.justification !== false),
    needsTicket: items.some((item) => item.activationRequirements?.ticket === true)
  };
}

export function tabLabel(tab: PopupTab): string {
  const labels: Record<PopupTab, string> = {
    directoryRole: "Entra Roles",
    pimGroup: "PIM Groups",
    azureRole: "Azure Roles",
    active: "Active",
    bundles: "Bundles"
  };
  return labels[tab];
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
    return "PIM Groups permissions missing. Add Graph PIM group read/write scopes in Entra consent.";
  }

  return `Microsoft Graph permission missing: ${missingScopes || "required scope"}.`;
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
