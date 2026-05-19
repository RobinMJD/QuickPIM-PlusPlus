import type { TokenKind } from "./types";
import { decodeToken } from "./token";

const API_HOSTS: Record<TokenKind, string> = {
  graph: "graph.microsoft.com",
  azureManagement: "management.azure.com"
};
const PORTAL_TOKEN_HOSTS = new Set(["entra.microsoft.com"]);

const GRAPH_AUDIENCES = new Set([
  "https://graph.microsoft.com",
  "https://graph.microsoft.com/",
  "00000003-0000-0000-c000-000000000000"
]);
const AZURE_MANAGEMENT_AUDIENCES = new Set([
  "https://management.azure.com",
  "https://management.azure.com/",
  "https://management.core.windows.net/",
  "797f4846-ba00-4fd7-ba43-dac1f8f63013"
]);

export type TokenValidationResult =
  | { ok: true; decoded: Record<string, unknown> }
  | { ok: false; reason: string };

export function getAllowedTokenKindForUrl(url: string): TokenKind | undefined {
  const parsed = safeUrl(url);
  if (!parsed || parsed.protocol !== "https:") {
    return undefined;
  }

  if (parsed.hostname === API_HOSTS.graph) {
    return "graph";
  }

  if (parsed.hostname === API_HOSTS.azureManagement) {
    return "azureManagement";
  }

  return undefined;
}

export function assertAllowedApiUrl(url: string, tokenKind?: TokenKind): void {
  const allowedKind = getAllowedTokenKindForUrl(url);
  if (!allowedKind) {
    throw new Error("API URL is not allowed.");
  }

  if (tokenKind && allowedKind !== tokenKind) {
    throw new Error("API URL does not match the required token kind.");
  }
}

export function isAllowedPortalTokenSource(url: string | undefined): boolean {
  const parsed = safeUrl(url || "");
  return Boolean(parsed && parsed.protocol === "https:" && PORTAL_TOKEN_HOSTS.has(parsed.hostname));
}

export function validateCapturedToken(token: string, tokenKind: TokenKind, now = Date.now()): TokenValidationResult {
  const decoded = decodeToken(token);
  if (!decoded) {
    return { ok: false, reason: "Token is not a valid JWT." };
  }

  const exp = Number(decoded.exp);
  if (!Number.isFinite(exp) || exp <= 0) {
    return { ok: false, reason: "Token does not contain a usable expiry." };
  }

  if (exp * 1000 <= now) {
    return { ok: false, reason: "Token is expired." };
  }

  if (!isAllowedAudience(decoded.aud, tokenKind)) {
    return { ok: false, reason: "Token audience does not match the requested API." };
  }

  return { ok: true, decoded };
}

export function sanitizeErrorMessage(error: unknown, maxLength = 240): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const redacted = raw
    .replace(/Bearer\s+[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "Bearer [redacted token]")
    .replace(/\b[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted token]")
    .replace(/\s+/g, " ")
    .trim();

  if (redacted.length <= maxLength) {
    return redacted;
  }

  return `${redacted.slice(0, maxLength - 1)}…`;
}

function isAllowedAudience(audience: unknown, tokenKind: TokenKind): boolean {
  const audiences = Array.isArray(audience) ? audience : [audience];
  const allowed = tokenKind === "graph" ? GRAPH_AUDIENCES : AZURE_MANAGEMENT_AUDIENCES;
  return audiences.some((item) => typeof item === "string" && allowed.has(item));
}

function safeUrl(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}
