import type { AccessSetupTarget, ActivationItem, TicketInfo } from "./types";

export type QuickPimMessage =
  | { action: "getTokenStatus" }
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

const SIMPLE_ACTIONS = new Set(["getTokenStatus", "clearToken"]);
const TARGETED_FETCH_ACTIONS = new Set(["getActivationItems", "getActiveItems", "getActivationSnapshot"]);
const MAX_PORTAL_TOKENS = 20;
const MAX_PORTAL_TOKEN_LENGTH = 8192;
const MAX_PORTAL_SOURCE_LENGTH = 160;

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
    const tokens = message.tokens.slice(0, MAX_PORTAL_TOKENS).map((token) => {
      if (typeof token !== "string" || token.length > MAX_PORTAL_TOKEN_LENGTH || !isJwtLike(token)) {
        throw new Error("Portal token is malformed.");
      }
      return token;
    });
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

  if (message.action === "deactivateItems") {
    if (message.justification !== undefined && typeof message.justification !== "string") {
      throw new Error("Deactivation justification must be text.");
    }

    if (message.ticketInfo !== undefined && !isRecord(message.ticketInfo)) {
      throw new Error("Ticket information must be an object.");
    }

    return {
      action: "deactivateItems",
      items: message.items as ActivationItem[],
      justification: typeof message.justification === "string" ? message.justification : undefined,
      ticketInfo: message.ticketInfo as TicketInfo | undefined
    };
  }

  if (!Number.isFinite(message.durationHours)) {
    throw new Error("Activation duration is required.");
  }

  if (typeof message.justification !== "string") {
    throw new Error("Activation justification is required.");
  }

  if (message.ticketInfo !== undefined && !isRecord(message.ticketInfo)) {
    throw new Error("Ticket information must be an object.");
  }

  return {
    action: "activateItems",
    items: message.items as ActivationItem[],
    durationHours: Number(message.durationHours),
    justification: message.justification,
    ticketInfo: message.ticketInfo as TicketInfo | undefined
  };
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
