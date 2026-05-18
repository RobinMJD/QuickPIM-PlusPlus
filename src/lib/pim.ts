import type {
  ActivationItem,
  ActivationRequest,
  AzureRoleApi,
  AzureRoleItem,
  DirectoryRoleDefinitionApi,
  DirectoryRoleApi,
  DirectoryRoleItem,
  GroupInfo,
  PimGroupApi,
  PimGroupItem,
  TicketInfo
} from "./types";

export function durationHoursToIso(durationHours: number): string {
  return `PT${Math.round(durationHours * 60)}M`;
}

export function buildDirectoryRoleDefinitionNameMap(
  definitions: DirectoryRoleDefinitionApi[]
): Record<string, string> {
  const entries = definitions.flatMap((definition) => {
    const displayName = definition.displayName;
    if (!displayName) {
      return [];
    }

    return [definition.id, definition.templateId]
      .filter((id): id is string => Boolean(id))
      .map((id) => [id, displayName] as const);
  });

  return Object.fromEntries(entries);
}

export function normalizeDirectoryRole(role: DirectoryRoleApi): DirectoryRoleItem {
  const roleDefinitionId = role.roleDefinitionId || role.id || "unknown-role";
  const directoryScopeId = role.directoryScopeId || "/";
  const roleName = role.roleDefinition?.displayName || role.roleName || role.roleDefinitionDisplayName || roleDefinitionId;

  return {
    id: `directoryRole:${roleDefinitionId}:${directoryScopeId}`,
    type: "directoryRole",
    sourceName: roleName,
    displayName: roleName,
    principalId: role.principalId || "",
    roleDefinitionId,
    directoryScopeId,
    scopeLabel: directoryScopeId === "/" ? "Tenant" : directoryScopeId,
    status: "eligible",
    activationRequirements: {
      justification: true,
      ticket: false
    },
    raw: role
  };
}

export function normalizeAzureRole(role: AzureRoleApi): AzureRoleItem {
  const properties = role.properties || {};
  const roleDefinitionId = properties.roleDefinitionId || role.roleDefinitionId || "unknown-role";
  const scope = properties.scope || extractScopeFromRoleDefinitionId(roleDefinitionId, role.subscriptionId);
  const expandedScope = properties.expandedProperties?.scope;
  const roleName =
    properties.expandedProperties?.roleDefinition?.displayName ||
    role.roleName ||
    leafName(roleDefinitionId) ||
    "Unknown Azure role";
  const subscriptionName = role.subscriptionName || role.subscriptionId || "Azure";
  const scopeName = expandedScope?.displayName || extractScopeName(scope);

  return {
    id: `azureRole:${roleDefinitionId}:${scope}`,
    type: "azureRole",
    sourceName: roleName,
    displayName: roleName,
    principalId: properties.principalId || role.principalId || "",
    roleDefinitionId,
    scope,
    subscriptionId: role.subscriptionId,
    subscriptionName: role.subscriptionName,
    roleEligibilityScheduleId: properties.roleEligibilityScheduleId,
    scopeLabel: scopeName ? `${subscriptionName} / ${scopeName}` : subscriptionName,
    status: "eligible",
    activationRequirements: {
      justification: true,
      ticket: false
    },
    raw: role
  };
}

export function normalizePimGroup(group: PimGroupApi, groupInfo: GroupInfo = {}): PimGroupItem {
  const groupId = group.groupId || groupInfo.id || "unknown-group";
  const accessId = group.accessId || "member";
  const sourceName = groupInfo.displayName || groupId;

  return {
    id: `pimGroup:${groupId}:${accessId}`,
    type: "pimGroup",
    sourceName,
    displayName: sourceName,
    principalId: group.principalId || "",
    groupId,
    accessId,
    memberType: group.memberType,
    scopeLabel: accessId === "owner" ? "Owner" : "Member",
    status: "eligible",
    activationRequirements: {
      justification: true,
      ticket: false
    },
    raw: group
  };
}

export function buildActivationRequest(
  item: ActivationItem,
  durationHours: number,
  justification: string,
  ticketInfo: TicketInfo = {},
  startDateTime = new Date().toISOString(),
  requestId: string = crypto.randomUUID()
): ActivationRequest {
  const duration = durationHoursToIso(durationHours);

  if (item.type === "directoryRole") {
    const body: Record<string, unknown> = {
      action: "selfActivate",
      principalId: item.principalId,
      roleDefinitionId: item.roleDefinitionId,
      directoryScopeId: item.directoryScopeId || "/",
      justification,
      scheduleInfo: {
        startDateTime,
        expiration: {
          type: "AfterDuration",
          duration
        }
      }
    };

    addTicketInfo(body, ticketInfo);

    return {
      endpoint: "https://graph.microsoft.com/v1.0/roleManagement/directory/roleAssignmentScheduleRequests",
      method: "POST",
      tokenKind: "graph",
      body
    };
  }

  if (item.type === "azureRole") {
    const body: Record<string, unknown> = {
      properties: {
        principalId: item.principalId,
        roleDefinitionId: item.roleDefinitionId,
        requestType: "SelfActivate",
        justification,
        scheduleInfo: {
          startDateTime,
          expiration: {
            type: "AfterDuration",
            endDateTime: null,
            duration
          }
        }
      }
    };

    const properties = body.properties as Record<string, unknown>;
    if (item.roleEligibilityScheduleId) {
      properties.linkedRoleEligibilityScheduleId = item.roleEligibilityScheduleId;
    }
    addTicketInfo(properties, ticketInfo);

    return {
      endpoint: `https://management.azure.com${item.scope}/providers/Microsoft.Authorization/roleAssignmentScheduleRequests/${requestId}?api-version=2020-10-01`,
      method: "PUT",
      tokenKind: "azureManagement",
      body
    };
  }

  const body: Record<string, unknown> = {
    accessId: item.accessId,
    principalId: item.principalId,
    groupId: item.groupId,
    action: "selfActivate",
    scheduleInfo: {
      startDateTime,
      expiration: {
        type: "afterDuration",
        duration
      }
    },
    justification
  };

  addTicketInfo(body, ticketInfo);

  return {
    endpoint: "https://graph.microsoft.com/v1.0/identityGovernance/privilegedAccess/group/assignmentScheduleRequests",
    method: "POST",
    tokenKind: "graph",
    body
  };
}

export function extractScopeName(scope: string): string {
  if (!scope) {
    return "";
  }

  const resourceGroup = scope.match(/\/resourceGroups\/([^/]+)/i)?.[1];
  if (!resourceGroup) {
    return "";
  }

  const resource = scope.match(/\/providers\/[^/]+\/[^/]+\/([^/]+)/i)?.[1];
  return resource ? `${decodeURIComponent(resourceGroup)} / ${decodeURIComponent(resource)}` : decodeURIComponent(resourceGroup);
}

export function parseIsoDurationMs(duration: string): number {
  const match = duration.match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i);
  if (!match) {
    return 0;
  }

  const [, days, hours, minutes, seconds] = match;
  return (
    (Number(days || 0) * 24 * 60 * 60 +
      Number(hours || 0) * 60 * 60 +
      Number(minutes || 0) * 60 +
      Number(seconds || 0)) *
    1000
  );
}

function addTicketInfo(target: Record<string, unknown>, ticketInfo: TicketInfo) {
  if (ticketInfo.ticketSystem || ticketInfo.ticketNumber) {
    target.ticketInfo = {
      ticketSystem: ticketInfo.ticketSystem || "Self-Service",
      ticketNumber: ticketInfo.ticketNumber || "N/A"
    };
  }
}

function extractScopeFromRoleDefinitionId(roleDefinitionId: string, subscriptionId?: string): string {
  const marker = "/providers/Microsoft.Authorization/roleDefinitions/";
  const index = roleDefinitionId.toLowerCase().indexOf(marker.toLowerCase());
  if (index > 0) {
    return roleDefinitionId.slice(0, index);
  }
  return subscriptionId ? `/subscriptions/${subscriptionId}` : "/";
}

function leafName(value: string): string {
  return value.split("/").filter(Boolean).at(-1) || value;
}
