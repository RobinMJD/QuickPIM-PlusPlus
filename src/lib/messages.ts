import type { AccessSetupTarget, ActivationItem, TicketInfo } from "./types";

export type QuickPimMessage =
  | { action: "getTokenStatus" }
  | { action: "refreshPortalTokens" }
  | { action: "clearToken" }
  | { action: "getActivationItems"; targets?: AccessSetupTarget[] }
  | { action: "getActiveItems"; targets?: AccessSetupTarget[] }
  | { action: "getActivationSnapshot"; targets?: AccessSetupTarget[] }
  | { action: "capturePortalTokens"; tokens: string[]; source?: string }
  | {
      action: "activateItems";
      items: ActivationItem[];
      durationHours: number;
      justification: string;
      ticketInfo?: TicketInfo;
    }
  | {
      action: "deactivateItems";
      items: ActivationItem[];
      justification?: string;
      ticketInfo?: TicketInfo;
    };

const SIMPLE_ACTIONS = new Set(["getTokenStatus", "refreshPortalTokens", "clearToken"]);
const TARGETED_FETCH_ACTIONS = new Set(["getActivationItems", "getActiveItems", "getActivationSnapshot"]);
const MAX_PORTAL_TOKENS = 20;
const MAX_PORTAL_TOKEN_LENGTH = 8192;
const MAX_PORTAL_SOURCE_LENGTH = 160;
const MAX_ACTIVATION_ITEMS = 100;
const MAX_ITEM_FIELD_LENGTH = 512;
const MAX_JUSTIFICATION_LENGTH = 1024;
const MAX_TICKET_FIELD_LENGTH = 128;

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

  if (message.action === "capturePortalTokens") {
    if (!Array.isArray(message.tokens)) {
      throw new Error("Portal tokens must be an array.");
    }
    const tokens = message.tokens
      .filter((token): token is string => typeof token === "string" && token.length <= MAX_PORTAL_TOKEN_LENGTH && isJwtLike(token))
      .slice(0, MAX_PORTAL_TOKENS);
    if (!tokens.length) {
      throw new Error("Portal tokens must not be empty.");
    }
    return {
      action: "capturePortalTokens",
      tokens,
      source: typeof message.source === "string" ? message.source.slice(0, MAX_PORTAL_SOURCE_LENGTH) : undefined
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

  if (message.action === "deactivateItems") {
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

  if (!Number.isFinite(message.durationHours)) {
    throw new Error("Activation duration is required.");
  }

  if (typeof message.justification !== "string" || message.justification.length > MAX_JUSTIFICATION_LENGTH) {
    throw new Error("Activation justification is required.");
  }

  return {
    action: "activateItems",
    items,
    durationHours: Number(message.durationHours),
    justification: message.justification,
    ticketInfo: validateTicketInfo(message.ticketInfo)
  };
}

function validateActivationItem(value: unknown, expectedStatus: "eligible" | "active"): ActivationItem {
  if (!isRecord(value) || !isBoundedString(value.id) || !isBoundedString(value.principalId) || value.status !== expectedStatus) {
    throw new Error(`Activation items must be valid ${expectedStatus} items.`);
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
