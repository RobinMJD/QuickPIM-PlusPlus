import type { AccessSetupTarget, ActivationItem, TicketInfo } from "./types";
import { MAX_ACTIVATION_DURATION_HOURS, MIN_ACTIVATION_DURATION_HOURS } from "./duration";
import { getActivationItemIdentity } from "./activationIdentity";
import { MAX_USER_JUSTIFICATION_LENGTH } from "./justifications";

export type QuickPimMessage =
  | { action: "getTokenStatus" }
  | { action: "refreshPortalTokens" }
  | { action: "getPortalRecoveryStatus" }
  | { action: "focusPortalRecoveryTabs" }
  | { action: "openPortalRecoveryTabs"; targets: AccessSetupTarget[] }
  | { action: "closePortalRecoveryTabs"; targets: AccessSetupTarget[] }
  | { action: "clearToken" }
  | { action: "getActivationItems"; targets?: AccessSetupTarget[] }
  | { action: "getActiveItems"; targets?: AccessSetupTarget[] }
  | { action: "getActivationSnapshot"; targets?: AccessSetupTarget[] }
  | { action: "refreshTrackedRequests"; requestIds?: string[] }
  | { action: "capturePortalTokens"; tokens: string[]; source?: string }
  | {
      action: "activateItems";
      items: ActivationItem[];
      durationHours: number;
      justification: string;
      ticketInfo?: TicketInfo;
      bundleName?: string;
    }
  | {
      action: "deactivateItems";
      items: ActivationItem[];
      justification?: string;
      ticketInfo?: TicketInfo;
    };

const SIMPLE_ACTIONS = new Set([
  "getTokenStatus",
  "refreshPortalTokens",
  "getPortalRecoveryStatus",
  "focusPortalRecoveryTabs",
  "clearToken"
]);
const TARGETED_FETCH_ACTIONS = new Set(["getActivationItems", "getActiveItems", "getActivationSnapshot"]);
const MAX_PORTAL_TOKEN_INPUTS = 200;
const MAX_PORTAL_TOKENS = 100;
const MAX_PORTAL_TOKEN_LENGTH = 8192;
const MAX_PORTAL_TOKEN_PAYLOAD_LENGTH = 512 * 1024;
const MAX_PORTAL_SOURCE_LENGTH = 160;
const MAX_ACTIVATION_ITEMS = 100;
const MAX_ITEM_FIELD_LENGTH = 512;
const MAX_JUSTIFICATION_LENGTH = MAX_USER_JUSTIFICATION_LENGTH;
const MAX_TICKET_FIELD_LENGTH = 128;
const MAX_REQUEST_IDS = 100;
const MAX_REQUEST_ID_LENGTH = 512;
const MAX_BUNDLE_NAME_LENGTH = 80;

export function validateQuickPimMessage(message: unknown): QuickPimMessage {
  if (!isRecord(message) || typeof message.action !== "string") {
    throw new Error("Unsupported QuickPIM++ message.");
  }

  if (SIMPLE_ACTIONS.has(message.action)) {
    return { action: message.action } as QuickPimMessage;
  }

  if (TARGETED_FETCH_ACTIONS.has(message.action)) {
    return {
      action: message.action,
      targets: sanitizeTargets(message.targets)
    } as QuickPimMessage;
  }

  if (message.action === "openPortalRecoveryTabs" || message.action === "closePortalRecoveryTabs") {
    const targets = sanitizeTargets(message.targets);
    if (!targets?.length) {
      throw new Error("Portal recovery targets must not be empty.");
    }
    return { action: message.action, targets };
  }

  if (message.action === "capturePortalTokens") {
    if (!Array.isArray(message.tokens)) {
      throw new Error("Portal tokens must be an array.");
    }
    const tokens = sanitizePortalTokens(message.tokens);
    if (!tokens.length) {
      throw new Error("Portal tokens must not be empty.");
    }
    return {
      action: "capturePortalTokens",
      tokens,
      source: typeof message.source === "string" ? message.source.slice(0, MAX_PORTAL_SOURCE_LENGTH) : undefined
    };
  }

  if (message.action === "refreshTrackedRequests") {
    return {
      action: "refreshTrackedRequests",
      requestIds: sanitizeRequestIds(message.requestIds)
    };
  }

  if (message.action !== "activateItems" && message.action !== "deactivateItems") {
    throw new Error("Unsupported QuickPIM++ message.");
  }

  if (!Array.isArray(message.items)) {
    throw new Error("Activation items must be an array.");
  }
  if (!message.items.length || message.items.length > MAX_ACTIVATION_ITEMS) {
    throw new Error(`Activation requests must contain between 1 and ${MAX_ACTIVATION_ITEMS} items.`);
  }
  const expectedStatus = message.action === "activateItems" ? "eligible" : "active";
  const items = message.items.map((item) => validateActivationItem(item, expectedStatus));
  assertUniqueActivationItems(items);

  if (message.action === "deactivateItems") {
    if (items.some((item) => item.activeAssignmentType && item.activeAssignmentType !== "activated")) {
      throw new Error("Only roles activated through PIM can be disabled from QuickPIM++.");
    }
    if (message.justification !== undefined && (typeof message.justification !== "string" || message.justification.length > MAX_JUSTIFICATION_LENGTH)) {
      throw new Error("Deactivation justification must be text.");
    }

    return {
      action: "deactivateItems",
      items,
      justification: typeof message.justification === "string" ? message.justification : undefined,
      ticketInfo: validateTicketInfo(message.ticketInfo)
    };
  }

  const durationHours = Number(message.durationHours);
  if (
    !Number.isFinite(durationHours)
    || durationHours < MIN_ACTIVATION_DURATION_HOURS
    || durationHours > MAX_ACTIVATION_DURATION_HOURS
  ) {
    throw new Error(
      `Activation duration must be between ${MIN_ACTIVATION_DURATION_HOURS} and ${MAX_ACTIVATION_DURATION_HOURS} hours.`
    );
  }
  const strictestPolicyMaximum = items.reduce<number | undefined>((strictest, item) => {
    const maximum = item.activationRequirements?.maxDurationHours;
    if (!Number.isFinite(maximum) || Number(maximum) <= 0) {
      return strictest;
    }
    return strictest === undefined ? Number(maximum) : Math.min(strictest, Number(maximum));
  }, undefined);
  if (strictestPolicyMaximum !== undefined && durationHours > strictestPolicyMaximum) {
    throw new Error(`Activation duration exceeds the selected item's ${strictestPolicyMaximum}-hour policy maximum.`);
  }

  if (typeof message.justification !== "string" || message.justification.length > MAX_JUSTIFICATION_LENGTH) {
    throw new Error("Activation justification is required.");
  }

  return {
    action: "activateItems",
    items,
    durationHours,
    justification: message.justification,
    ticketInfo: validateTicketInfo(message.ticketInfo),
    bundleName: typeof message.bundleName === "string" ? message.bundleName.trim().slice(0, MAX_BUNDLE_NAME_LENGTH) || undefined : undefined
  };
}

function assertUniqueActivationItems(items: ActivationItem[]): void {
  const seen = new Set<string>();
  for (const item of items) {
    const identity = getActivationItemIdentity(item);
    if (seen.has(identity)) {
      throw new Error("Activation requests must not contain duplicate items.");
    }
    seen.add(identity);
  }
}

function validateActivationItem(value: unknown, expectedStatus: "eligible" | "active"): ActivationItem {
  if (!isRecord(value) || !isBoundedString(value.id) || !isBoundedString(value.principalId) || value.status !== expectedStatus) {
    throw new Error(`Activation items must be valid ${expectedStatus} items.`);
  }
  if (value.activeAssignmentType !== undefined && value.activeAssignmentType !== "activated" && value.activeAssignmentType !== "assigned" && value.activeAssignmentType !== "unknown") {
    throw new Error("Activation assignment type is invalid.");
  }
  if (value.type === "directoryRole") {
    if (!isBoundedString(value.roleDefinitionId) || !isBoundedString(value.directoryScopeId)) {
      throw new Error("Entra role item identifiers are invalid.");
    }
  } else if (value.type === "pimGroup") {
    if (!isBoundedString(value.groupId) || (value.accessId !== "member" && value.accessId !== "owner")) {
      throw new Error("PIM group item identifiers are invalid.");
    }
  } else if (value.type === "azureRole") {
    if (!isBoundedString(value.roleDefinitionId) || !isBoundedString(value.scope)) {
      throw new Error("Azure role item identifiers are invalid.");
    }
  } else {
    throw new Error("Activation item type is unsupported.");
  }
  return value as unknown as ActivationItem;
}

function validateTicketInfo(value: unknown): TicketInfo | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error("Ticket information must be an object.");
  }
  for (const field of [value.ticketSystem, value.ticketNumber]) {
    if (field !== undefined && (typeof field !== "string" || field.length > MAX_TICKET_FIELD_LENGTH)) {
      throw new Error("Ticket information is invalid or too long.");
    }
  }
  return {
    ...(typeof value.ticketSystem === "string" ? { ticketSystem: value.ticketSystem } : {}),
    ...(typeof value.ticketNumber === "string" ? { ticketNumber: value.ticketNumber } : {})
  };
}

function isBoundedString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ITEM_FIELD_LENGTH;
}

export function isTrustedRuntimeSender(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function sanitizeTargets(value: unknown): AccessSetupTarget[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error("Fetch targets must be an array.");
  }

  const seen = new Set<AccessSetupTarget>();
  const targets: AccessSetupTarget[] = [];
  for (const item of value) {
    if (item !== "directoryRole" && item !== "pimGroup" && item !== "azureRole") {
      throw new Error("Fetch target is unsupported.");
    }
    if (!seen.has(item)) {
      seen.add(item);
      targets.push(item);
    }
  }
  return targets;
}

function isJwtLike(value: string): boolean {
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value);
}

function sanitizePortalTokens(value: unknown[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  let totalLength = 0;

  for (const token of value.slice(0, MAX_PORTAL_TOKEN_INPUTS)) {
    if (
      typeof token !== "string"
      || token.length > MAX_PORTAL_TOKEN_LENGTH
      || !isJwtLike(token)
      || seen.has(token)
      || totalLength + token.length > MAX_PORTAL_TOKEN_PAYLOAD_LENGTH
    ) {
      continue;
    }
    seen.add(token);
    result.push(token);
    totalLength += token.length;
    if (result.length >= MAX_PORTAL_TOKENS) break;
  }

  return result;
}

function sanitizeRequestIds(value: unknown): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error("Tracked request identifiers must be an array.");
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const id = item.trim();
    if (!id || id.length > MAX_REQUEST_ID_LENGTH || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
    if (result.length >= MAX_REQUEST_IDS) break;
  }
  return result;
}
