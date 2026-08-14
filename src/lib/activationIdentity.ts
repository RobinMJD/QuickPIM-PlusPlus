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

export function normalizeActivationItemId(value: string): string {
  const trimmed = value.trim();
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

function normalizeResourcePath(value: string): string {
  const normalized = value.trim().toLowerCase();
  return /^\/+$/u.test(normalized) ? "/" : normalized.replace(/\/+$/, "");
}
