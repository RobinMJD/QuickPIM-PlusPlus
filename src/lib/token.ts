import type { TokenKind, TokenStatusEntry } from "./types";

const TOKEN_MAX_AGE_MINUTES = 45;

export function makeTokenStatus(
  token?: string,
  timestamp?: number,
  source?: string,
  now = Date.now()
): TokenStatusEntry {
  if (!token || timestamp === undefined) {
    return { hasToken: false };
  }

  const decoded = decodeToken(token);
  const expiresAtMs = getTokenExpiryMs(decoded);
  const tokenAge = Math.max(0, Math.round((now - timestamp) / 60000));
  const expiresInMinutes = expiresAtMs === undefined ? undefined : Math.max(0, Math.floor((expiresAtMs - now) / 60000));

  return {
    hasToken: true,
    capturedAt: timestamp,
    tokenAge,
    expiresAt: expiresAtMs === undefined ? undefined : new Date(expiresAtMs).toISOString(),
    expiresInMinutes,
    isExpired: expiresAtMs === undefined ? tokenAge > TOKEN_MAX_AGE_MINUTES : expiresAtMs <= now,
    grantedScopes: getGrantedScopes(decoded),
    source
  };
}

export function assertFreshToken(token: string, tokenKind: TokenKind, now = Date.now()): void {
  const decoded = decodeToken(token);
  if (!decoded) {
    throw new Error(tokenKind === "graph" ? "Graph token is invalid." : "Azure Management token is invalid.");
  }

  if (getTokenExpiryMs(decoded) === undefined) {
    throw new Error(tokenKind === "graph" ? "Graph token expiry is invalid." : "Azure Management token expiry is invalid.");
  }

  if (isDecodedTokenExpired(decoded, now)) {
    throw new Error(tokenKind === "graph" ? "Graph token expired. Refresh in portal." : "Azure Management token expired. Refresh in portal.");
  }
}

export function decodeToken(token: string): Record<string, unknown> | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) {
      return null;
    }
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const decoded = JSON.parse(atob(padded));
    return decoded && typeof decoded === "object" && !Array.isArray(decoded) ? decoded as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function isDecodedTokenExpired(decoded: Record<string, unknown>, now: number): boolean {
  const expiresAtMs = getTokenExpiryMs(decoded);
  return expiresAtMs !== undefined && expiresAtMs <= now;
}

function getTokenExpiryMs(decoded: Record<string, unknown> | null): number | undefined {
  const exp = Number(decoded?.exp);
  return Number.isFinite(exp) && exp > 0 ? exp * 1000 : undefined;
}

function getGrantedScopes(decoded: Record<string, unknown> | null): string[] {
  const delegatedScopes =
    typeof decoded?.scp === "string"
      ? decoded.scp.split(/\s+/).filter(Boolean)
      : [];
  const appRoles = Array.isArray(decoded?.roles) ? decoded.roles.filter((role): role is string => typeof role === "string") : [];
  return [...new Set([...delegatedScopes, ...appRoles])].sort((a, b) => a.localeCompare(b));
}
