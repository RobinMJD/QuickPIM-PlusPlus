import type { AccessSetupTarget, ActivationItem } from "./types";

export function getActivationItemIdentity(item: ActivationItem): string {
  const legacyIdentity = getLegacyActivationItemIdentity(item);
  const tenantId = item.tenantId?.trim().toLowerCase();
  return tenantId ? `tenant:${tenantId}:${legacyIdentity}` : legacyIdentity;
}

export function getLegacyActivationItemIdentity(item: ActivationItem): string {
  if (item.type === "directoryRole") {
    return `directoryRole:${item.roleDefinitionId.toLowerCase()}:${normalizeResourcePath(item.directoryScopeId)}`;
  }
  if (item.type === "pimGroup") {
    return `pimGroup:${item.groupId.toLowerCase()}:${item.accessId.toLowerCase()}`;
  }
  const roleDefinitionId = item.roleDefinitionId.split("/").filter(Boolean).at(-1) || item.roleDefinitionId;
  return `azureRole:${roleDefinitionId.toLowerCase()}:${normalizeResourcePath(item.scope)}`;
}

export function getActivationItemIdentityCandidates(item: ActivationItem): string[] {
  const canonical = getActivationItemIdentity(item);
  if (item.tenantId?.trim()) {
    return [canonical];
  }
  const legacy = getLegacyActivationItemIdentity(item);
  return canonical === legacy ? [canonical] : [canonical, legacy];
}

export function activationItemMatchesIdentity(item: ActivationItem, identity: string): boolean {
  const normalizedIdentity = normalizeActivationItemId(identity);
  return getActivationItemIdentityCandidates(item)
    .some((candidate) => normalizeActivationItemId(candidate) === normalizedIdentity);
}

export function normalizeActivationItemId(value: string): string {
  const trimmed = value.trim();
  const tenantMatch = /^tenant:([^:]+):(.+)$/iu.exec(trimmed);
  if (tenantMatch) {
    return `tenant:${tenantMatch[1].toLowerCase()}:${normalizeActivationItemId(tenantMatch[2])}`;
  }
  const separator = trimmed.indexOf(":");
  if (separator < 0) return trimmed.toLowerCase();
  const rawType = trimmed.slice(0, separator).toLowerCase();
  const type = rawType === "directoryrole"
    ? "directoryRole"
    : rawType === "pimgroup"
      ? "pimGroup"
      : rawType === "azurerole"
        ? "azureRole"
        : rawType;
  return `${type}:${trimmed.slice(separator + 1).toLowerCase()}`;
}

export function getActivationItemTypeFromIdentity(value: string): AccessSetupTarget | undefined {
  const normalized = normalizeActivationItemId(value);
  const withoutTenant = normalized.startsWith("tenant:")
    ? normalized.split(":").slice(2).join(":")
    : normalized;
  const separator = withoutTenant.indexOf(":");
  const type = separator >= 0 ? withoutTenant.slice(0, separator) : withoutTenant;
  return type === "directoryRole" || type === "pimGroup" || type === "azureRole"
    ? type
    : undefined;
}

function normalizeResourcePath(value: string): string {
  const normalized = value.trim().toLowerCase();
  return /^\/+$/u.test(normalized) ? "/" : normalized.replace(/\/+$/, "");
}
