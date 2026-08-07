import type { TokenStatus, TokenStatusEntry } from "./types";

export interface IdentityContext {
  label?: string;
  detail?: string;
  principalName?: string;
  principalId?: string;
  tenantId?: string;
  mismatch: boolean;
  identityCount: number;
}

export function getIdentityContext(tokenStatus: TokenStatus | null | undefined): IdentityContext {
  if (!tokenStatus) return { mismatch: false, identityCount: 0 };

  const candidates = [
    tokenStatus.graphTargets?.directoryRole,
    tokenStatus.graphTargets?.pimGroup,
    tokenStatus.graph,
    tokenStatus.azureManagement
  ].filter(isUsableIdentity);
  const identities = new Map<string, TokenStatusEntry>();
  for (const candidate of candidates) {
    const key = `${candidate.tenantId || "unknown"}:${candidate.principalId || "unknown"}`;
    if (!identities.has(key)) identities.set(key, candidate);
  }

  const values = [...identities.values()];
  const preferred = values[0];
  if (!preferred) return { mismatch: false, identityCount: 0 };

  const account = preferred.principalName || (preferred.principalId ? `Account ...${preferred.principalId.slice(-6)}` : "Microsoft account");
  const tenant = preferred.tenantId ? `tenant ...${preferred.tenantId.slice(-6)}` : undefined;
  return {
    label: tenant ? `${account} / ${tenant}` : account,
    detail: values.map(formatIdentityDetail).join(" | "),
    principalName: preferred.principalName,
    principalId: preferred.principalId,
    tenantId: preferred.tenantId,
    mismatch: values.length > 1,
    identityCount: values.length
  };
}

function isUsableIdentity(value: TokenStatusEntry | undefined): value is TokenStatusEntry {
  return Boolean(value?.hasToken && !value.isExpired && (value.tenantId || value.principalId || value.principalName));
}

function formatIdentityDetail(value: TokenStatusEntry): string {
  const account = value.principalName || value.principalId || "unknown account";
  const tenant = value.tenantId || "unknown tenant";
  return `${account} (${tenant})`;
}
