import type { TokenKind, TokenStatus, TokenStatusEntry } from "./types";

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
  const principalName = getPrincipalName(decoded);

  return {
    hasToken: true,
    ...(typeof decoded?.tid === "string" ? { tenantId: decoded.tid } : {}),
    ...(typeof decoded?.oid === "string" ? { principalId: decoded.oid } : {}),
    ...(principalName ? { principalName } : {}),
    capturedAt: timestamp,
    tokenAge,
    expiresAt: expiresAtMs === undefined ? undefined : new Date(expiresAtMs).toISOString(),
    expiresInMinutes,
    isExpired: expiresAtMs === undefined ? tokenAge > TOKEN_MAX_AGE_MINUTES : expiresAtMs <= now,
    grantedScopes: getGrantedScopes(decoded),
    source
  };
}

export function refreshTokenStatusFreshness(status: TokenStatus, now = Date.now()): TokenStatus {
  return {
    graph: refreshTokenStatusEntry(status.graph, now),
    ...(status.graphTargets ? {
      graphTargets: Object.fromEntries(
        Object.entries(status.graphTargets).map(([target, entry]) => [
          target,
          entry ? refreshTokenStatusEntry(entry, now) : entry
        ])
      ) as TokenStatus["graphTargets"]
    } : {}),
    azureManagement: refreshTokenStatusEntry(status.azureManagement, now)
  };
}

function refreshTokenStatusEntry(entry: TokenStatusEntry, now: number): TokenStatusEntry {
  if (!entry.hasToken) {
    return entry;
  }
  const expiresAt = entry.expiresAt ? Date.parse(entry.expiresAt) : Number.NaN;
  const capturedAt = Number(entry.capturedAt);
  const hasKnownExpiry = Number.isFinite(expiresAt);
  return {
    ...entry,
    ...(Number.isFinite(capturedAt) ? { tokenAge: Math.max(0, Math.round((now - capturedAt) / 60_000)) } : {}),
    expiresInMinutes: hasKnownExpiry ? Math.max(0, Math.floor((expiresAt - now) / 60_000)) : undefined,
    // Every captured token is validated with an exp claim before storage. An
    // in-memory fallback without one must therefore fail closed.
    isExpired: !hasKnownExpiry || expiresAt <= now
  };
}

function getPrincipalName(decoded: Record<string, unknown> | null): string | undefined {
  for (const claim of ["preferred_username", "upn", "unique_name", "name"]) {
    const value = decoded?.[claim];
    if (typeof value === "string") {
      const sanitized = value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 160);
      if (sanitized) return sanitized;
    }
  }
  return undefined;
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
