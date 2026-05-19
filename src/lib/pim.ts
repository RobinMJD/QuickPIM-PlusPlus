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
  RoleManagementPolicyAssignmentApi,
  RoleManagementPolicyRuleApi,
  TicketInfo
} from "./types";
import { azureManagementUrl, encodePathSegment, graphApiUrl } from "./apiUrls";
import { formatJustificationForActivationRequest, getGenericJustificationWarning } from "./justifications";

const MAX_DURATION_HOURS = 24;
const MAX_JUSTIFICATION_LENGTH = 1024;
const MAX_TICKET_FIELD_LENGTH = 128;

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

export function extractActivationRequirementsFromPolicyRules(
  rules: RoleManagementPolicyRuleApi[]
): Partial<NonNullable<ActivationItem["activationRequirements"]>> {
  const endUserAssignmentRules = rules.filter(isEndUserAssignmentRule);
  const expirationRule = endUserAssignmentRules.find((rule) => rule.id === "Expiration_EndUser_Assignment" || rule.maximumDuration);
  const enablementRule = endUserAssignmentRules.find((rule) => rule.id === "Enablement_EndUser_Assignment" || rule.enabledRules);
  const approvalRule = endUserAssignmentRules.find((rule) => rule.id === "Approval_EndUser_Assignment" || rule.setting);
  const enabledRules = enablementRule?.enabledRules || [];
  const maximumDuration = expirationRule?.maximumDuration;
  const requirements: Partial<NonNullable<ActivationItem["activationRequirements"]>> = {};

  if (maximumDuration) {
    requirements.maxDurationHours = parseIsoDurationMs(maximumDuration) / 3600000;
  }

  if (enablementRule) {
    requirements.justification = enabledRules.includes("Justification");
    requirements.ticket = enabledRules.includes("Ticketing");
  }

  if (approvalRule?.setting?.isRequestorJustificationRequired === true) {
    requirements.justification = true;
  }

  return requirements;
}

export function buildRolePolicyRequirementMap(
  assignments: RoleManagementPolicyAssignmentApi[]
): Record<string, Partial<NonNullable<ActivationItem["activationRequirements"]>>> {
  const entries = assignments.flatMap((assignment) => {
    const rules = getPolicyAssignmentRules(assignment);
    if (!rules.length) {
      return [];
    }
    const requirements = extractActivationRequirementsFromPolicyRules(rules);
    return getPolicyAssignmentKeys(assignment).map((key) => [key, requirements] as const);
  });
  return Object.fromEntries(entries);
}

export function getRoleDefinitionLookupKeys(roleDefinitionId: string | undefined): string[] {
  if (!roleDefinitionId) {
    return [];
  }
  const lower = roleDefinitionId.toLowerCase();
  const leaf = lower.split("/").filter(Boolean).at(-1);
  return [...new Set([lower, leaf].filter((key): key is string => Boolean(key)))];
}

export function getActiveUntilFromScheduleInfo(scheduleInfo: unknown): string | undefined {
  if (!isRecord(scheduleInfo)) {
    return undefined;
  }
  const expiration = isRecord(scheduleInfo.expiration) ? scheduleInfo.expiration : {};
  const endDateTime = typeof expiration.endDateTime === "string" ? expiration.endDateTime : undefined;
  if (endDateTime && Number.isFinite(new Date(endDateTime).getTime())) {
    return new Date(endDateTime).toISOString();
  }
  const startDateTime = typeof scheduleInfo.startDateTime === "string" ? scheduleInfo.startDateTime : undefined;
  const duration = typeof expiration.duration === "string" ? expiration.duration : undefined;
  if (!startDateTime || !duration) {
    return undefined;
  }
  const startMs = new Date(startDateTime).getTime();
  const durationMs = parseIsoDurationMs(duration);
  if (!Number.isFinite(startMs) || durationMs <= 0) {
    return undefined;
  }
  return new Date(startMs + durationMs).toISOString();
}

export function applyActivationRequirements<T extends ActivationItem>(
  item: T,
  requirements: Partial<NonNullable<ActivationItem["activationRequirements"]>> | undefined
): T {
  if (!requirements) {
    return item;
  }

  return {
    ...item,
    activationRequirements: {
      ...item.activationRequirements,
      ...requirements
    }
  };
}

export function normalizeDirectoryRole(role: DirectoryRoleApi): DirectoryRoleItem {
  const roleDefinitionId = role.roleDefinitionId || role.id || "unknown-role";
  const directoryScopeId = role.directoryScopeId || "/";
  const roleName = role.roleDefinition?.displayName || role.roleName || role.roleDefinitionDisplayName || roleDefinitionId;
  const scopeName = role.directoryScopeDisplayName || role.directoryScope?.displayName;
  const isPrivileged = role.isPrivileged ?? role.roleDefinition?.isPrivileged;

  return {
    id: `directoryRole:${roleDefinitionId}:${directoryScopeId}`,
    type: "directoryRole",
    sourceName: roleName,
    displayName: roleName,
    principalId: role.principalId || "",
    roleDefinitionId,
    directoryScopeId,
    scopeLabel: directoryScopeId === "/" ? "Tenant" : scopeName || directoryScopeId,
    status: "eligible",
    ...(typeof isPrivileged === "boolean" ? { isPrivileged } : {}),
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
  const scopeLabel = formatAzureScopeLabel(scope, expandedScope, subscriptionName);

  return {
    id: `azureRole:${leafName(roleDefinitionId)}:${scope}`,
    type: "azureRole",
    sourceName: roleName,
    displayName: roleName,
    principalId: properties.principalId || role.principalId || "",
    roleDefinitionId,
    scope,
    subscriptionId: role.subscriptionId,
    subscriptionName: role.subscriptionName,
    roleEligibilityScheduleId: properties.roleEligibilityScheduleId,
    scopeLabel,
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
  validateActivationInput(item, durationHours, justification, ticketInfo);
  const duration = durationHoursToIso(durationHours);
  const requestJustification = formatJustificationForActivationRequest(justification);

  if (item.type === "directoryRole") {
    const body: Record<string, unknown> = {
      action: "selfActivate",
      principalId: item.principalId,
      roleDefinitionId: item.roleDefinitionId,
      directoryScopeId: item.directoryScopeId || "/",
      justification: requestJustification,
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
      endpoint: graphApiUrl("/v1.0/roleManagement/directory/roleAssignmentScheduleRequests"),
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
        justification: requestJustification,
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
      endpoint: azureManagementUrl(
        `${item.scope}/providers/Microsoft.Authorization/roleAssignmentScheduleRequests/${encodePathSegment(requestId)}?api-version=2020-10-01`
      ),
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
    justification: requestJustification
  };

  addTicketInfo(body, ticketInfo);

  return {
    endpoint: graphApiUrl("/v1.0/identityGovernance/privilegedAccess/group/assignmentScheduleRequests"),
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

function formatAzureScopeLabel(
  scope: string,
  expandedScope: { displayName?: string; type?: string } | undefined,
  subscriptionName: string
): string {
  const expandedDisplayName = typeof expandedScope?.displayName === "string" ? expandedScope.displayName : undefined;
  if (isManagementGroupScope(scope, expandedScope?.type)) {
    return expandedDisplayName || leafName(scope) || scope;
  }

  if (isSubscriptionScope(scope, expandedScope?.type)) {
    return expandedDisplayName || subscriptionName || leafName(scope) || scope;
  }

  const scopeName = expandedDisplayName || extractScopeName(scope);
  if (!scopeName) {
    return subscriptionName || scope;
  }

  return scopeName === subscriptionName ? scopeName : `${subscriptionName} / ${scopeName}`;
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

function getPolicyAssignmentKeys(assignment: RoleManagementPolicyAssignmentApi): string[] {
  return [
    ...getRoleDefinitionLookupKeys(assignment.roleDefinitionId),
    ...getRoleDefinitionLookupKeys(assignment.properties?.roleDefinitionId),
    ...getRoleDefinitionLookupKeys(assignment.id)
  ];
}

function getPolicyAssignmentRules(assignment: RoleManagementPolicyAssignmentApi): RoleManagementPolicyRuleApi[] {
  return (
    assignment.policy?.rules ||
    assignment.policy?.effectiveRules ||
    assignment.properties?.effectiveRules ||
    assignment.properties?.policy?.rules ||
    assignment.properties?.policy?.effectiveRules ||
    []
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function validateActivationInput(
  item: ActivationItem,
  durationHours: number,
  justification: string,
  ticketInfo: TicketInfo
): void {
  if (!Number.isFinite(durationHours) || durationHours <= 0 || durationHours > MAX_DURATION_HOURS) {
    throw new Error(`Activation duration must be between 0 and ${MAX_DURATION_HOURS} hours.`);
  }

  if (typeof justification !== "string" || justification.length > MAX_JUSTIFICATION_LENGTH) {
    throw new Error(`Activation justification must be ${MAX_JUSTIFICATION_LENGTH} characters or fewer.`);
  }
  const genericJustificationWarning = getGenericJustificationWarning(justification);
  if (genericJustificationWarning) {
    throw new Error(`Generic activation justification is not allowed. ${genericJustificationWarning}`);
  }

  if ((ticketInfo.ticketSystem?.length || 0) > MAX_TICKET_FIELD_LENGTH || (ticketInfo.ticketNumber?.length || 0) > MAX_TICKET_FIELD_LENGTH) {
    throw new Error(`Ticket fields must be ${MAX_TICKET_FIELD_LENGTH} characters or fewer.`);
  }

  if (!item || typeof item !== "object") {
    throw new Error("Activation item is invalid.");
  }

  if (!item.id || !item.displayName || !item.principalId) {
    throw new Error("Activation item is missing required identifiers.");
  }

  if (item.type === "directoryRole") {
    if (!item.roleDefinitionId || !item.directoryScopeId) {
      throw new Error("Directory role activation item is missing required identifiers.");
    }
    return;
  }

  if (item.type === "azureRole") {
    if (!isSafeAzureScope(item.scope) || !item.roleDefinitionId) {
      throw new Error("Azure role activation item has an invalid scope or role definition.");
    }
    return;
  }

  if (item.type === "pimGroup") {
    if (!item.groupId || (item.accessId !== "member" && item.accessId !== "owner")) {
      throw new Error("PIM group activation item is missing required identifiers.");
    }
    return;
  }

  throw new Error("Unsupported activation item type.");
}

function isSafeAzureScope(scope: string): boolean {
  return (
    (/^\/subscriptions\/[^/?#\s]+(?:\/[^?#]*)?$/i.test(scope) ||
      /^\/providers\/Microsoft\.Management\/managementGroups\/[^/?#\s]+$/i.test(scope)) &&
    !scope.includes("..")
  );
}

function isManagementGroupScope(scope: string, type: string | undefined): boolean {
  return (
    normalizeAzureScopeType(type) === "managementgroup" ||
    /^\/providers\/Microsoft\.Management\/managementGroups\//i.test(scope)
  );
}

function isSubscriptionScope(scope: string, type: string | undefined): boolean {
  return normalizeAzureScopeType(type) === "subscription" || /^\/subscriptions\/[^/]+$/i.test(scope);
}

function normalizeAzureScopeType(type: string | undefined): string {
  return (type || "").replace(/\s+/g, "").toLowerCase();
}

function isEndUserAssignmentRule(rule: RoleManagementPolicyRuleApi): boolean {
  const target = rule.target;
  return (
    (target?.caller === "EndUser" && target.level === "Assignment") ||
    Boolean(rule.id?.includes("_EndUser_Assignment"))
  );
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
