import { getEffectiveTrackedRequestStatus } from "./requestTracking";
import { getGenericJustificationWarning } from "./justifications";
import type { ActivationItem, ActivationResult, TicketInfo, TrackedPimRequest } from "./types";

export const EXTENSION_DURATION_OPTIONS = [0.5, 1, 2, 4] as const;
export const DEFAULT_EXTENSION_DURATION_HOURS = EXTENSION_DURATION_OPTIONS[0];

export interface TrackedRequestExtensionPlan {
  item: ActivationItem;
  durationHours: number;
  startDateTime: string;
  endDateTime: string;
  justification: string;
  ticketInfo: TicketInfo;
}

export function sanitizeExtensionDurationHours(value: unknown): number {
  const duration = Number(value);
  return EXTENSION_DURATION_OPTIONS.includes(duration as typeof EXTENSION_DURATION_OPTIONS[number])
    ? duration
    : DEFAULT_EXTENSION_DURATION_HOURS;
}

export function formatExtensionDuration(durationHours: number): string {
  if (durationHours < 1) return `${Math.round(durationHours * 60)} minutes`;
  return `${durationHours} ${durationHours === 1 ? "hour" : "hours"}`;
}

export function requireTrackedRequestExtensionRequestId(result: ActivationResult): string {
  const requestId = result.requestId?.trim();
  if (!requestId) {
    throw new Error(
      "Microsoft accepted the extension request but did not return a tracking identifier. Check Microsoft PIM before trying again."
    );
  }
  return requestId;
}

export function buildTrackedRequestExtensionPlan(
  request: TrackedPimRequest,
  preferredDurationHours: number,
  now = Date.now()
): TrackedRequestExtensionPlan {
  if (request.action !== "activate" || getEffectiveTrackedRequestStatus(request, now) !== "active") {
    throw new Error("Only a currently active PIM activation can be extended.");
  }
  if (request.extensionAttemptState === "submitting" || request.extensionAttemptState === "uncertain") {
    throw new Error("An earlier extension attempt may still be processing. Check Microsoft PIM before trying again.");
  }
  if (request.extensionAttemptState === "queued" || request.extensionRequestId) {
    throw new Error("An extension is already queued for this activation.");
  }

  const activeUntil = request.activeUntil ? Date.parse(request.activeUntil) : Number.NaN;
  if (!Number.isFinite(activeUntil) || activeUntil <= now) {
    throw new Error("Microsoft did not provide a future expiry time for this activation.");
  }

  const preferred = sanitizeExtensionDurationHours(preferredDurationHours);
  const policyMaximum = request.activationRequirements?.maxDurationHours;
  const durationHours = Number.isFinite(policyMaximum) && Number(policyMaximum) > 0
    ? Math.min(preferred, Number(policyMaximum))
    : preferred;
  if (durationHours < DEFAULT_EXTENSION_DURATION_HOURS) {
    throw new Error("This role policy does not allow a 30-minute continuation.");
  }

  const justification = request.justification?.trim() || "";
  if (request.activationRequirements?.justification !== false && !justification) {
    throw new Error("This role requires a justification, but the original request reason is unavailable.");
  }
  const genericJustificationWarning = getGenericJustificationWarning(justification);
  if (genericJustificationWarning) {
    throw new Error(`The original request reason cannot be reused. ${genericJustificationWarning}`);
  }
  const ticketInfo: TicketInfo = {
    ...(request.ticketSystem ? { ticketSystem: request.ticketSystem } : {}),
    ...(request.ticketNumber ? { ticketNumber: request.ticketNumber } : {})
  };
  if (request.activationRequirements?.ticket && (!ticketInfo.ticketSystem || !ticketInfo.ticketNumber)) {
    throw new Error("This role requires ticket details, but the original request details are unavailable.");
  }

  // Use the first complete UTC second after expiry. This remains non-overlapping
  // if Microsoft rounds a millisecond-bearing source timestamp to whole seconds.
  const continuationStart = Math.ceil(activeUntil / 1_000) * 1_000 + 1_000;
  const startDateTime = new Date(continuationStart).toISOString();
  const endDateTime = new Date(continuationStart + durationHours * 60 * 60 * 1_000).toISOString();
  return {
    item: trackedRequestToEligibleItem(request),
    durationHours,
    startDateTime,
    endDateTime,
    justification,
    ticketInfo
  };
}

function trackedRequestToEligibleItem(request: TrackedPimRequest): ActivationItem {
  const common = {
    id: request.itemId,
    sourceName: request.itemName,
    displayName: request.itemName,
    principalId: request.principalId,
    scopeLabel: request.scopeLabel || "Scope",
    status: "eligible" as const,
    ...(request.tenantId ? { tenantId: request.tenantId } : {}),
    ...(request.activationRequirements ? { activationRequirements: request.activationRequirements } : {})
  };

  if (request.itemType === "directoryRole") {
    if (!request.roleDefinitionId || !request.directoryScopeId) {
      throw new Error("The tracked Entra role is missing identifiers needed to extend it.");
    }
    return {
      ...common,
      type: "directoryRole",
      roleDefinitionId: request.roleDefinitionId,
      directoryScopeId: request.directoryScopeId
    };
  }
  if (request.itemType === "pimGroup") {
    if (!request.groupId || !request.accessId) {
      throw new Error("The tracked PIM group is missing identifiers needed to extend it.");
    }
    return {
      ...common,
      type: "pimGroup",
      groupId: request.groupId,
      accessId: request.accessId
    };
  }
  if (!request.roleDefinitionId || !request.azureScope || !request.roleEligibilityScheduleId) {
    throw new Error("The tracked Azure role is missing identifiers needed to extend it.");
  }
  return {
    ...common,
    type: "azureRole",
    roleDefinitionId: request.roleDefinitionId,
    scope: request.azureScope,
    roleEligibilityScheduleId: request.roleEligibilityScheduleId
  };
}
