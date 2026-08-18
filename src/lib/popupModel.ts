import { CLAIMS_CHALLENGE_MESSAGE, isClaimsChallengeMessage } from "./apiErrors";
import { getActivationItemIdentity, getActivationItemIdentityCandidates } from "./activationIdentity";
import type { AccessCapabilityItem } from "./access";
import type {
  AccessSetupTarget,
  ActivationItem,
  ActivationResponse,
  ActivationResult,
  ActivationStatus,
  PopupRequestMode,
  PopupTab,
  QuickPimBundle,
  RoleTab,
  TokenStatus,
  TokenStatusEntry
} from "./types";
import {
  activationItemIdentitiesMatch,
  normalizeActivationItemId
} from "./activationIdentity";
export type { PopupTab, RoleTab } from "./types";

export const ENTRA_PORTAL_URLS: Record<RoleTab, string> = {
  directoryRole:
    "https://entra.microsoft.com/#view/Microsoft_Azure_PIMCommon/ActivationMenuBlade/~/aadmigratedroles",
  pimGroup:
    "https://entra.microsoft.com/#view/Microsoft_Azure_PIMCommon/ActivationMenuBlade/~/aadgroup",
  azureRole:
    "https://entra.microsoft.com/#view/Microsoft_Azure_PIMCommon/ActivationMenuBlade/~/azurerbac"
};

export function getPortalUrlForTab(tab: PopupTab): string | undefined {
  if (tab === "directoryRole" || tab === "pimGroup" || tab === "azureRole") {
    return ENTRA_PORTAL_URLS[tab];
  }
  return undefined;
}

export function tokenStatusText(label: string, status: TokenStatusEntry | undefined): string {
  if (!status?.hasToken) {
    return `${label} access needed`;
  }

  if (status.isExpired) {
    return `${label} refresh needed`;
  }

  const age = status.tokenAge ?? 0;
  return `${label} ready (${age} min ago)`;
}

export type PopupAccessSourceState = "ready" | "limited" | "refreshNeeded" | "accessNeeded" | "notNeeded" | "checking";

export interface PopupAccessSourceStatus {
  id: AccessSetupTarget;
  label: "Entra Roles" | "PIM Groups" | "Azure Roles";
  needed: boolean;
  state: PopupAccessSourceState;
  value: string;
  tone: "ok" | "warn" | "idle";
  detail?: string;
}

export interface PopupAccessStatusSummary {
  label: "Access ready" | "Limited access" | "Access needed" | "Refresh needed" | "Access not needed" | "Checking access";
  tone: "ok" | "warn" | "idle";
}

const POPUP_ACCESS_SOURCE_LABELS: Record<AccessSetupTarget, PopupAccessSourceStatus["label"]> = {
  directoryRole: "Entra Roles",
  pimGroup: "PIM Groups",
  azureRole: "Azure Roles"
};

const POPUP_ACCESS_SOURCE_ORDER: AccessSetupTarget[] = ["directoryRole", "pimGroup", "azureRole"];

export function getPopupAccessSourceStatuses(
  enabledTargets: AccessSetupTarget[],
  tokenStatus: TokenStatus | null | undefined,
  accessCapabilities: AccessCapabilityItem[]
): PopupAccessSourceStatus[] {
  const enabled = new Set(enabledTargets);
  const capabilitiesByTarget = new Map(accessCapabilities.map((capability) => [capability.target, capability]));
  return POPUP_ACCESS_SOURCE_ORDER.map((target) => buildPopupAccessSourceStatus(
    target,
    enabled.has(target),
    getTargetTokenStatus(target, tokenStatus),
    capabilitiesByTarget.get(target),
    tokenStatus !== null && tokenStatus !== undefined
  ));
}

export function getPopupAccessStatusSummary(
  sources: PopupAccessSourceStatus[]
): PopupAccessStatusSummary {
  const neededSources = sources.filter((source) => source.needed);
  if (!neededSources.length) {
    return { label: "Access not needed", tone: "idle" };
  }
  if (neededSources.some((source) => source.state === "accessNeeded")) {
    return { label: "Access needed", tone: "warn" };
  }
  if (neededSources.some((source) => source.state === "refreshNeeded")) {
    return { label: "Refresh needed", tone: "warn" };
  }
  if (neededSources.some((source) => source.state === "limited")) {
    return { label: "Limited access", tone: "warn" };
  }
  if (neededSources.some((source) => source.state === "checking")) {
    return { label: "Checking access", tone: "idle" };
  }
  return { label: "Access ready", tone: "ok" };
}

function buildPopupAccessSourceStatus(
  target: AccessSetupTarget,
  needed: boolean,
  token: TokenStatusEntry | undefined,
  capability: AccessCapabilityItem | undefined,
  tokenStatusLoaded: boolean
): PopupAccessSourceStatus {
  const base = { id: target, label: POPUP_ACCESS_SOURCE_LABELS[target], needed };
  if (!needed) {
    return { ...base, state: "notNeeded", value: "Not needed", tone: "idle" };
  }
  if (!tokenStatusLoaded) {
    return { ...base, state: "checking", value: "Checking", tone: "idle" };
  }
  if (!token?.hasToken) {
    return { ...base, state: "accessNeeded", value: "Access needed", tone: "warn", detail: capability?.detail };
  }
  if (token.isExpired) {
    return { ...base, state: "refreshNeeded", value: "Refresh needed", tone: "warn", detail: capability?.detail };
  }
  if (capability?.status === "limited") {
    return { ...base, state: "limited", value: "Limited", tone: "warn", detail: capability.detail };
  }
  if (capability?.status === "needsPortalRefresh") {
    return { ...base, state: "refreshNeeded", value: "Refresh needed", tone: "warn", detail: capability.detail };
  }
  if (!capability) {
    return { ...base, state: "checking", value: "Checking", tone: "idle" };
  }
  const age = token.tokenAge ?? 0;
  return { ...base, state: "ready", value: `Ready (${age} min ago)`, tone: "ok", detail: capability.detail };
}

function getTargetTokenStatus(
  target: AccessSetupTarget,
  tokenStatus: TokenStatus | null | undefined
): TokenStatusEntry | undefined {
  if (target === "azureRole") {
    return tokenStatus?.azureManagement;
  }
  return tokenStatus?.graphTargets?.[target] || tokenStatus?.graph;
}

export function attachKnownTenantIdentities(
  items: ActivationItem[],
  tokenStatus: TokenStatus | null | undefined
): ActivationItem[] {
  return items.map((item) => {
    if (item.tenantId) return item;
    const token = getTargetTokenStatus(item.type, tokenStatus);
    if (
      !token?.hasToken
      || token.isExpired
      || !token.tenantId
      || !token.principalId
      || token.principalId.toLowerCase() !== item.principalId.toLowerCase()
    ) {
      return item;
    }
    return { ...item, tenantId: token.tenantId };
  });
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
  const successfulIds = results.filter((result) => result.success).map((result) => result.itemId);
  return new Set([...selectedIds].filter((itemId) =>
    !successfulIds.some((successfulId) => activationItemIdentitiesMatch(itemId, successfulId))));
}

export function normalizeActivationResponse(response: ActivationResponse): ActivationResponse {
  const byItemId = new Map<string, ActivationResult>();
  for (const result of [...response.results, ...response.errors]) {
    const key = normalizeActivationItemId(result.itemId);
    const current = byItemId.get(key);
    if (!current) {
      byItemId.set(key, { ...result });
      continue;
    }
    if (current.success !== result.success) {
      byItemId.set(key, {
        ...current,
        ...result,
        success: false,
        error: result.error || current.error || "QuickPIM++ received conflicting results for this item. Refresh its status before retrying."
      });
      continue;
    }
    byItemId.set(key, {
      ...current,
      ...result,
      error: result.error || current.error
    });
  }
  const results = [...byItemId.values()];
  const errors = results.filter((result) => !result.success);
  return {
    ...response,
    success: results.length > 0 && errors.length === 0,
    results,
    errors
  };
}

export function buildActivationItemLookup(items: ActivationItem[]): Map<string, ActivationItem> {
  const lookup = new Map<string, ActivationItem>();
  const ambiguous = new Set<string>();
  for (const item of items) {
    const canonicalIdentity = getActivationItemIdentity(item);
    const keys = new Set([
      canonicalIdentity,
      item.id,
      normalizeActivationItemId(item.id),
      ...getActivationItemIdentityCandidates(item)
    ].filter(Boolean).flatMap((key) => [key, normalizeActivationItemId(key)]));
    for (const key of keys) {
      if (ambiguous.has(key)) continue;
      const current = lookup.get(key);
      if (current && normalizeActivationItemId(getActivationItemIdentity(current)) !== normalizeActivationItemId(canonicalIdentity)) {
        lookup.delete(key);
        ambiguous.add(key);
      } else {
        lookup.set(key, item);
      }
    }
  }
  return lookup;
}

export function getRequestReconciliationTargets(
  results: ActivationResult[],
  items: Array<Pick<ActivationItem, "id" | "type">>
): AccessSetupTarget[] {
  const requested = new Set<AccessSetupTarget>();
  for (const result of results) {
    if (!result.success && !result.outcomeUnknown) {
      continue;
    }
    const matches = items.filter((item) => activationItemIdentitiesMatch(item.id, result.itemId));
    if (matches.length === 1) {
      requested.add(matches[0].type);
    }
  }
  return (["directoryRole", "pimGroup", "azureRole"] as AccessSetupTarget[])
    .filter((target) => requested.has(target));
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
    const identity = getActivationItemIdentity(item);
    const current = activeById.get(identity);
    if (!current || isPreferredActiveOverlay(item, current)) {
      activeById.set(identity, item);
    }
  }
  const merged = eligibleItems.map((item) => {
    const activeItem = activeById.get(getActivationItemIdentity(item));
    const activationRequirements = {
      ...item.activationRequirements,
      ...activeItem?.activationRequirements
    };
    return activeItem
      ? {
          ...item,
          status: activeItem.status,
          activeAssignmentType: activeItem.activeAssignmentType || item.activeAssignmentType,
          activeUntil: activeItem.activeUntil || item.activeUntil,
          assignmentScheduleId: activeItem.assignmentScheduleId || item.assignmentScheduleId,
          assignmentScheduleInstanceId: activeItem.assignmentScheduleInstanceId || item.assignmentScheduleInstanceId,
          ...(Object.keys(activationRequirements).length ? { activationRequirements } : {})
        }
      : item;
  });

  if (!options.includeActiveOnly) {
    return merged;
  }

  const mergedIds = new Set(merged.map(getActivationItemIdentity));
  const activeOnlyItems = [...activeById.entries()]
    .filter(([identity]) => !mergedIds.has(identity))
    .map(([, item]) => item);
  return [...merged, ...activeOnlyItems];
}

function isPreferredActiveOverlay(candidate: ActivationItem, current: ActivationItem): boolean {
  const candidatePriority = getActiveOverlayPriority(candidate);
  const currentPriority = getActiveOverlayPriority(current);
  if (candidatePriority !== currentPriority) {
    return candidatePriority > currentPriority;
  }
  const candidateEnd = candidate.activeUntil ? Date.parse(candidate.activeUntil) : 0;
  const currentEnd = current.activeUntil ? Date.parse(current.activeUntil) : 0;
  return (Number.isFinite(candidateEnd) ? candidateEnd : 0) > (Number.isFinite(currentEnd) ? currentEnd : 0);
}

function getActiveOverlayPriority(item: ActivationItem): number {
  if (item.status !== "active") {
    return 0;
  }
  const assignmentType = getEffectiveActiveAssignmentType(item);
  if (assignmentType === "activated") {
    return 3;
  }
  if (assignmentType === "assigned") {
    return 2;
  }
  return 1;
}

export function getActivatableItems(items: ActivationItem[]): ActivationItem[] {
  return items.filter((item) => item.status === "eligible");
}

export function filterAssignedActiveItems(items: ActivationItem[], showAssignedRoles: boolean): ActivationItem[] {
  return showAssignedRoles
    ? items
    : items.filter((item) => item.status !== "active" || getEffectiveActiveAssignmentType(item) === "activated");
}

export function getDeactivatableItems(items: ActivationItem[], now = Date.now()): ActivationItem[] {
  return items.filter((item) => {
    const actionState = getRowActionState(item, now);
    return actionState.selectable && actionState.mode === "deactivate";
  });
}

export type QuickFilter = "active";

export interface RowActionState {
  mode?: PopupRequestMode;
  selectable: boolean;
  reason?: string;
}

export interface BundlePreflight {
  readyItems: ActivationItem[];
  readyCount: number;
  alreadyActiveCount: number;
  pendingApprovalCount: number;
  missingCount: number;
  blockedCount: number;
  needsJustification: boolean;
  needsTicket: boolean;
  needsApproval: boolean;
  strictestMaxDurationHours?: number;
  durationHours?: number;
  isBlocked: boolean;
  blockedReason?: string;
}

export function getRowActionState(item: ActivationItem | undefined, now = Date.now()): RowActionState {
  if (!item) {
    return { selectable: false, reason: "Item is not available." };
  }
  if (item.status === "eligible") {
    return { mode: "activate", selectable: true };
  }
  if (item.status === "pendingApproval") {
    return { selectable: false, reason: "This request is pending approval." };
  }
  if (item.status === "active") {
    const activeUntil = item.activeUntil ? Date.parse(item.activeUntil) : Number.NaN;
    if (Number.isFinite(activeUntil) && activeUntil <= now) {
      return {
        mode: "deactivate",
        selectable: false,
        reason: "This PIM activation has expired. Refresh roles to update its status."
      };
    }
    const activeAssignmentType = getEffectiveActiveAssignmentType(item);
    if (activeAssignmentType === "assigned") {
      return {
        mode: "deactivate",
        selectable: false,
        reason: "This role is active through an assigned access grant, not a PIM activation, so it cannot be disabled from QuickPIM++."
      };
    }
    if (activeAssignmentType === "unknown") {
      return {
        mode: "deactivate",
        selectable: false,
        reason: "Microsoft did not identify this assignment as a PIM activation, so QuickPIM++ will not try to disable it."
      };
    }
    const hasDisableTarget = item.type === "azureRole"
      ? Boolean(item.assignmentScheduleId || item.assignmentScheduleInstanceId)
      : Boolean(item.assignmentScheduleId);
    if (hasDisableTarget) {
      return { mode: "deactivate", selectable: true };
    }
    return {
      mode: "deactivate",
      selectable: false,
      reason: "Microsoft did not expose the schedule identifier needed to disable this active item."
    };
  }
  return { selectable: false, reason: "This item cannot be requested from here." };
}

export function getRowPolicySummary(item: ActivationItem): string[] {
  if (item.activationPolicyState === "pending") {
    const activeUntil = item.status === "active" && item.activeUntil ? `Active until: ${item.activeUntil.slice(0, 10)}` : undefined;
    return ["Activation policy will be checked before the request", activeUntil].filter((value): value is string => Boolean(value));
  }
  const requirements = item.activationRequirements || {};
  const maxDuration = requirements.maxDurationHours
    ? `Max duration: ${formatDurationLabel(requirements.maxDurationHours)}`
    : "Max duration: tenant policy default";
  const approval = requirements.approval ? "Approval required" : "Approval not required";
  const justification = requirements.justification === false ? "Reason not required" : "Reason required";
  const ticket = requirements.ticket ? "Ticket required" : "Ticket not required";
  const activeUntil = item.status === "active" && item.activeUntil ? `Active until: ${item.activeUntil.slice(0, 10)}` : undefined;
  const disableReason = item.status === "active" ? getRowActionState(item).reason : undefined;
  return [maxDuration, justification, ticket, approval, activeUntil, disableReason].filter((value): value is string => Boolean(value));
}

export function applyQuickFilters(
  items: ActivationItem[],
  filters: QuickFilter[]
): ActivationItem[] {
  if (!filters.includes("active")) {
    return items;
  }
  return items.filter((item) => item.status === "active" && getEffectiveActiveAssignmentType(item) === "activated");
}

export function getBundlePreflight(
  bundle: QuickPimBundle,
  items: ActivationItem[],
  justification: string
): BundlePreflight {
  const itemsById = buildActivationItemLookup(items);
  const readyItems: ActivationItem[] = [];
  let alreadyActiveCount = 0;
  let pendingApprovalCount = 0;
  let missingCount = 0;
  let blockedCount = 0;

  for (const itemId of bundle.itemIds) {
    const item = itemsById.get(itemId) || itemsById.get(normalizeActivationItemId(itemId));
    if (!item) {
      missingCount += 1;
      continue;
    }
    if (item.status === "eligible") {
      readyItems.push(item);
      continue;
    }
    if (item.status === "active") {
      alreadyActiveCount += 1;
      continue;
    }
    if (item.status === "pendingApproval") {
      pendingApprovalCount += 1;
      continue;
    }
    blockedCount += 1;
  }

  const requirements = getActivationRequirements(readyItems);
  const strictestMaxDurationHours = getSelectedMaxDurationHours(readyItems);
  const durationHours = coerceDurationForItems(bundle.defaultDurationHours || strictestMaxDurationHours || BASE_DURATION_VALUES[0], readyItems);
  const needsJustification = requirements.needsJustification;
  const missingJustification = needsJustification && !(bundle.defaultJustification || justification).trim();
  const isBlocked = !readyItems.length || missingJustification || requirements.needsTicket;
  const blockedReason = !readyItems.length
    ? "No bundle items are currently eligible."
    : missingJustification
      ? "A required justification is missing."
      : requirements.needsTicket
        ? "This bundle contains a ticket-required item. Load the selection, then enter the ticket details in the activation review."
        : undefined;

  return {
    readyItems,
    readyCount: readyItems.length,
    alreadyActiveCount,
    pendingApprovalCount,
    missingCount,
    blockedCount,
    needsJustification,
    needsTicket: requirements.needsTicket,
    needsApproval: readyItems.some((item) => item.activationRequirements?.approval === true),
    strictestMaxDurationHours,
    durationHours,
    isBlocked,
    blockedReason
  };
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

export function formatRemainingActivationTime(activeUntil: string | undefined, now = Date.now()): string | undefined {
  if (!activeUntil) {
    return undefined;
  }
  const activeUntilMs = Date.parse(activeUntil);
  if (!Number.isFinite(activeUntilMs)) {
    return undefined;
  }
  if (activeUntilMs <= now) {
    return undefined;
  }
  const totalSeconds = Math.ceil((activeUntilMs - now) / 1000);
  if (totalSeconds > 3600) {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

export function getRemainingActivationTimeUpdateDelay(activeUntil: string | undefined, now = Date.now()): number | undefined {
  if (!activeUntil) {
    return undefined;
  }
  const activeUntilMs = Date.parse(activeUntil);
  const remainingMs = activeUntilMs - now;
  if (!Number.isFinite(activeUntilMs) || remainingMs <= 0) {
    return undefined;
  }

  const totalSeconds = Math.ceil(remainingMs / 1000);
  let nextDisplayedSecond: number;
  if (totalSeconds <= 3600) {
    nextDisplayedSecond = totalSeconds - 1;
  } else {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    nextDisplayedSecond = hours === 1 && minutes === 0
      ? 3600
      : hours * 3600 + minutes * 60 - 1;
  }
  return Math.max(50, remainingMs - nextDisplayedSecond * 1000 + 20);
}

export function getActivationStatusTitle(item: ActivationItem, now = Date.now()): string | undefined {
  if (item.status === "pendingApproval") {
    return item.activationRequirements?.approval
      ? "Activation request is waiting for approval."
      : "Activation request is pending.";
  }
  const activeAssignmentType = getEffectiveActiveAssignmentType(item);
  if (activeAssignmentType === "assigned") {
    return "Assigned access is active without a PIM activation and cannot be disabled from QuickPIM++.";
  }
  if (activeAssignmentType === "unknown") {
    return "Active assignment type was not identified by Microsoft; disabling is unavailable.";
  }
  return getActiveStatusTitle(item, now);
}

export function formatActivationItemStatusLabel(item: ActivationItem): string {
  const activeAssignmentType = getEffectiveActiveAssignmentType(item);
  if (activeAssignmentType === "activated") {
    return "PIM active";
  }
  if (activeAssignmentType === "assigned") {
    return "Assigned";
  }
  return formatActivationStatusLabel(item.status);
}

export function getEffectiveActiveAssignmentType(item: ActivationItem): ActivationItem["activeAssignmentType"] | undefined {
  if (item.status !== "active") {
    return undefined;
  }
  if (item.activeAssignmentType) {
    return item.activeAssignmentType;
  }
  return item.assignmentScheduleId || item.assignmentScheduleInstanceId ? "activated" : "unknown";
}

export function shouldShowRemainingActivationTime(
  item: ActivationItem,
  showRemainingActivationTime: boolean,
  now = Date.now()
): boolean {
  return showRemainingActivationTime
    && getEffectiveActiveAssignmentType(item) === "activated"
    && formatRemainingActivationTime(item.activeUntil, now) !== undefined;
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

  if (isMinimumActiveDurationMessage(messageText) || isMinimumActiveDurationMessage(trimmed)) {
    return "Microsoft requires an activation to remain active for at least 5 minutes before it can be disabled. Retry after the five-minute minimum.";
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

function isMinimumActiveDurationMessage(message: string): boolean {
  return /active duration is too short/i.test(message) && /min(?:i?mum|iumum) required is 5 minutes/i.test(message);
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
