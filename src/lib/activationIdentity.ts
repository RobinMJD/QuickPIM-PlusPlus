import type { ActivationItem } from "./types";

export function getActivationItemIdentity(item: ActivationItem): string {
  if (item.type === "directoryRole") {
    return `directoryRole:${item.roleDefinitionId.toLowerCase()}:${normalizeResourcePath(item.directoryScopeId)}`;
  }
  if (item.type === "pimGroup") {
    return `pimGroup:${item.groupId.toLowerCase()}:${item.accessId.toLowerCase()}`;
  }
  const roleDefinitionId = item.roleDefinitionId.split("/").filter(Boolean).at(-1) || item.roleDefinitionId;
  return `azureRole:${roleDefinitionId.toLowerCase()}:${normalizeResourcePath(item.scope)}`;
}

function normalizeResourcePath(value: string): string {
  const normalized = value.trim().toLowerCase();
  return /^\/+$/u.test(normalized) ? "/" : normalized.replace(/\/+$/, "");
}
