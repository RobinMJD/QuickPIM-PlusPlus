import {
  applyActivationRequirements,
  buildDirectoryRoleDefinitionNameMap,
  buildActivationRequest,
  extractActivationRequirementsFromPolicyRules,
  normalizeAzureRole,
  normalizeDirectoryRole,
  normalizePimGroup,
  parseIsoDurationMs
} from "./lib/pim";
import { assertFreshToken, decodeToken, makeTokenStatus } from "./lib/token";
import type {
  ActivationItem,
  ActivationResponse,
  AzureRoleApi,
  DirectoryRoleDefinitionApi,
  DirectoryRoleApi,
  GroupInfo,
  PimGroupApi,
  RoleManagementPolicyAssignmentApi,
  TicketInfo,
  TokenKind,
  TokenStatus
} from "./lib/types";

type QuickPimMessage =
  | { action: "getTokenStatus" }
  | { action: "manualSetToken"; token: string; tokenKind?: TokenKind }
  | { action: "clearToken" }
  | { action: "getActivationItems" }
  | { action: "getActiveItems" }
  | {
      action: "activateItems";
      items: ActivationItem[];
      durationHours: number;
      justification: string;
      ticketInfo?: TicketInfo;
    };

interface StoredTokens {
  graphToken?: string;
  tokenTimestamp?: number;
  tokenSource?: string;
  azureManagementToken?: string;
  azureManagementTokenTimestamp?: number;
  azureManagementTokenSource?: string;
}

type ActivationRequirements = NonNullable<ActivationItem["activationRequirements"]>;

chrome.webRequest.onSendHeaders.addListener(
  (details) => captureToken(details),
  { urls: ["https://graph.microsoft.com/*", "https://management.azure.com/*"] },
  ["requestHeaders"]
);

chrome.runtime.onMessage.addListener((message: QuickPimMessage, _sender, sendResponse) => {
  handleMessage(message)
    .then((data) => sendResponse({ success: true, data }))
    .catch((error: unknown) => {
      console.error("QuickPIM background error:", error);
      sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) });
    });
  return true;
});

async function handleMessage(message: QuickPimMessage): Promise<unknown> {
  switch (message.action) {
    case "getTokenStatus":
      return getTokenStatus();
    case "manualSetToken":
      await setManualToken(message.token, message.tokenKind || "graph");
      return true;
    case "clearToken":
      await clearTokens();
      return true;
    case "getActivationItems":
      return getActivationItems();
    case "getActiveItems":
      return getActiveItems();
    case "activateItems":
      return activateItems(message.items, message.durationHours, message.justification, message.ticketInfo || {});
    default:
      throw new Error("Unsupported QuickPIM message");
  }
}

function captureToken(details: chrome.webRequest.WebRequestHeadersDetails): void {
  const authHeader = details.requestHeaders?.find((header) => header.name.toLowerCase() === "authorization");
  if (!authHeader?.value?.startsWith("Bearer ")) {
    return;
  }

  const token = authHeader.value.slice(7);
  if (details.url.includes("graph.microsoft.com")) {
    void chrome.storage.local.set({
      graphToken: token,
      tokenTimestamp: Date.now(),
      tokenSource: details.url
    });
  }

  if (details.url.includes("management.azure.com")) {
    void chrome.storage.local.set({
      azureManagementToken: token,
      azureManagementTokenTimestamp: Date.now(),
      azureManagementTokenSource: details.url
    });
  }
}

async function getStoredTokens(): Promise<StoredTokens> {
  return chrome.storage.local.get([
    "graphToken",
    "tokenTimestamp",
    "tokenSource",
    "azureManagementToken",
    "azureManagementTokenTimestamp",
    "azureManagementTokenSource"
  ]);
}

async function setManualToken(token: string, tokenKind: TokenKind): Promise<void> {
  if (!token || token.length < 50) {
    throw new Error("Invalid token provided");
  }

  if (tokenKind === "azureManagement") {
    await chrome.storage.local.set({
      azureManagementToken: token,
      azureManagementTokenTimestamp: Date.now(),
      azureManagementTokenSource: "manual-entry"
    });
    return;
  }

  await chrome.storage.local.set({
    graphToken: token,
    tokenTimestamp: Date.now(),
    tokenSource: "manual-entry"
  });
}

async function clearTokens(): Promise<void> {
  await chrome.storage.local.remove([
    "graphToken",
    "tokenTimestamp",
    "tokenSource",
    "azureManagementToken",
    "azureManagementTokenTimestamp",
    "azureManagementTokenSource"
  ]);
}

async function getTokenStatus(): Promise<TokenStatus> {
  const tokens = await getStoredTokens();
  return {
    graph: makeTokenStatus(tokens.graphToken, tokens.tokenTimestamp, tokens.tokenSource),
    azureManagement: makeTokenStatus(
      tokens.azureManagementToken,
      tokens.azureManagementTokenTimestamp,
      tokens.azureManagementTokenSource
    )
  };
}

async function getActivationItems(): Promise<{ items: ActivationItem[]; errors: string[] }> {
  const tokens = await getStoredTokens();
  const errors: string[] = [];
  const itemGroups = await Promise.allSettled([
    tokens.graphToken ? getDirectoryRoles(tokens.graphToken) : Promise.resolve([]),
    tokens.azureManagementToken ? getAzureRoles(tokens.azureManagementToken) : Promise.resolve([]),
    tokens.graphToken ? getPimGroups(tokens.graphToken) : Promise.resolve([])
  ]);

  const items: ActivationItem[] = [];
  for (const result of itemGroups) {
    if (result.status === "fulfilled") {
      items.push(...result.value);
    } else {
      errors.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
    }
  }

  return { items: dedupeItems(items), errors };
}

async function getActiveItems(): Promise<{ items: ActivationItem[]; errors: string[] }> {
  const tokens = await getStoredTokens();
  const errors: string[] = [];
  const itemGroups = await Promise.allSettled([
    tokens.graphToken ? getActiveDirectoryRoles(tokens.graphToken) : Promise.resolve([]),
    tokens.azureManagementToken ? getActiveAzureRoles(tokens.azureManagementToken) : Promise.resolve([]),
    tokens.graphToken ? getActivePimGroups(tokens.graphToken) : Promise.resolve([])
  ]);

  const items: ActivationItem[] = [];
  for (const result of itemGroups) {
    if (result.status === "fulfilled") {
      items.push(...result.value);
    } else {
      errors.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
    }
  }

  return { items: dedupeItems(items), errors };
}

async function getDirectoryRoles(graphToken: string): Promise<ActivationItem[]> {
  assertFreshToken(graphToken, "graph");
  const principalId = requirePrincipalId(graphToken);
  const query = new URLSearchParams({
    "$filter": `principalId eq '${principalId}'`,
    "$expand": "roleDefinition"
  });
  const roles = await fetchAllPages<DirectoryRoleApi>(
    `https://graph.microsoft.com/v1.0/roleManagement/directory/roleEligibilitySchedules?${query.toString()}`,
    graphToken
  );
  const definitions = await getDirectoryRoleDefinitionsBestEffort(graphToken);
  const policyRequirements = await getDirectoryRolePolicyRequirementsBestEffort(graphToken);

  return roles.map((role) => {
    const namedRole = withDirectoryRoleDefinitionName(role, definitions);
    const item = normalizeDirectoryRole(namedRole);
    return applyActivationRequirements(
      item,
      policyRequirements[item.roleDefinitionId.toLowerCase()] ||
        policyRequirements[(namedRole.roleDefinition?.id || "").toLowerCase()] ||
        policyRequirements[(namedRole.roleDefinition?.templateId || "").toLowerCase()]
    );
  });
}

async function getDirectoryRoleDefinitions(graphToken: string): Promise<Record<string, string>> {
  const roles = await fetchAllPages<DirectoryRoleDefinitionApi>(
    "https://graph.microsoft.com/v1.0/roleManagement/directory/roleDefinitions",
    graphToken
  );
  return buildDirectoryRoleDefinitionNameMap(roles);
}

async function getDirectoryRoleDefinitionsBestEffort(graphToken: string): Promise<Record<string, string>> {
  try {
    return await getDirectoryRoleDefinitions(graphToken);
  } catch (error) {
    console.warn("QuickPIM could not resolve directory role definitions:", error);
    return {};
  }
}

async function getDirectoryRolePolicyRequirementsBestEffort(
  graphToken: string
): Promise<Record<string, Partial<ActivationRequirements>>> {
  const scopeTypes = ["DirectoryRole", "Directory"];
  const results = await Promise.allSettled(
    scopeTypes.map((scopeType) => {
      const query = new URLSearchParams({
        "$filter": `scopeId eq '/' and scopeType eq '${scopeType}'`,
        "$expand": "policy($expand=rules)"
      });
      return fetchAllPages<RoleManagementPolicyAssignmentApi>(
        `https://graph.microsoft.com/beta/policies/roleManagementPolicyAssignments?${query.toString()}`,
        graphToken
      );
    })
  );

  return buildRolePolicyRequirementMap(
    results.flatMap((result) => (result.status === "fulfilled" ? result.value : []))
  );
}

function withDirectoryRoleDefinitionName(role: DirectoryRoleApi, definitions: Record<string, string>): DirectoryRoleApi {
  const roleDefinitionId = role.roleDefinitionId || role.roleDefinition?.id || role.roleDefinition?.templateId || role.id || "";
  return {
    ...role,
    roleName:
      role.roleName ||
      role.roleDefinition?.displayName ||
      definitions[roleDefinitionId] ||
      definitions[role.roleDefinition?.id || ""] ||
      definitions[role.roleDefinition?.templateId || ""]
  };
}

async function getPimGroups(graphToken: string): Promise<ActivationItem[]> {
  assertFreshToken(graphToken, "graph");
  const schedules = await fetchAllPages<PimGroupApi>(
    "https://graph.microsoft.com/v1.0/identityGovernance/privilegedAccess/group/eligibilitySchedules/filterByCurrentUser(on='principal')",
    graphToken
  );
  const groupIds = [...new Set(schedules.map((schedule) => schedule.groupId).filter(Boolean) as string[])];
  const groupInfos = await getGroupInfos(
    graphToken,
    groupIds
  );
  const policyRequirements = await getPimGroupPolicyRequirementsBestEffort(graphToken, groupIds);

  return schedules.map((schedule) => {
    const item = normalizePimGroup(schedule, groupInfos[schedule.groupId || ""]);
    const groupPolicy = policyRequirements[item.groupId];
    return applyActivationRequirements(item, groupPolicy?.[item.accessId] || groupPolicy?.default);
  });
}

async function getPimGroupPolicyRequirementsBestEffort(
  graphToken: string,
  groupIds: string[]
): Promise<Record<string, Record<string, Partial<ActivationRequirements>>>> {
  const entries = await Promise.all(
    groupIds.map(async (groupId) => {
      try {
        const query = new URLSearchParams({
          "$filter": `scopeId eq '${groupId}' and scopeType eq 'Group'`,
          "$expand": "policy($expand=rules)"
        });
        const assignments = await fetchAllPages<RoleManagementPolicyAssignmentApi>(
          `https://graph.microsoft.com/beta/policies/roleManagementPolicyAssignments?${query.toString()}`,
          graphToken
        );
        const requirementsByRole = buildRolePolicyRequirementMap(assignments);
        return [
          groupId,
          Object.fromEntries(
            Object.entries(requirementsByRole).map(([roleDefinitionId, requirements]) => [
              roleDefinitionId.toLowerCase().includes("owner") ? "owner" : roleDefinitionId.toLowerCase().includes("member") ? "member" : "default",
              requirements
            ])
          )
        ] as const;
      } catch {
        return [groupId, {}] as const;
      }
    })
  );
  return Object.fromEntries(entries);
}

async function getGroupInfos(graphToken: string, groupIds: string[]): Promise<Record<string, GroupInfo>> {
  const entries = await Promise.all(
    groupIds.map(async (groupId) => {
      try {
        const group = await fetchJson<GroupInfo>(
          `https://graph.microsoft.com/v1.0/groups/${groupId}?$select=id,displayName,description,mail`,
          graphToken
        );
        return [groupId, group] as const;
      } catch {
        return [groupId, { id: groupId, displayName: groupId }] as const;
      }
    })
  );
  return Object.fromEntries(entries);
}

async function getAzureRoles(azureManagementToken: string): Promise<ActivationItem[]> {
  assertFreshToken(azureManagementToken, "azureManagement");
  const subscriptions = await getSubscriptions(azureManagementToken);
  const roleGroups = await Promise.allSettled(
    subscriptions.map(async (subscription) => {
      const roles = await fetchAllPages<AzureRoleApi>(
        `https://management.azure.com/subscriptions/${subscription.subscriptionId}/providers/Microsoft.Authorization/roleEligibilityScheduleInstances?api-version=2020-10-01&$filter=asTarget()`,
        azureManagementToken
      );
      return roles.map((role) =>
        normalizeAzureRole({
          ...role,
          subscriptionId: subscription.subscriptionId,
          subscriptionName: subscription.displayName
        })
      );
    })
  );

  const items = roleGroups.flatMap((group) => (group.status === "fulfilled" ? group.value : []));
  const itemsWithPolicies = await applyAzureRolePolicyRequirements(items, azureManagementToken);
  return applyAzureRoleDefinitionNames(itemsWithPolicies, azureManagementToken);
}

async function applyAzureRolePolicyRequirements(items: ActivationItem[], token: string): Promise<ActivationItem[]> {
  const azureItems = items.filter((item): item is Extract<ActivationItem, { type: "azureRole" }> => item.type === "azureRole");
  const uniqueScopes = [...new Set(azureItems.map((item) => item.scope))];
  const policyEntries = await Promise.all(
    uniqueScopes.map(async (scope) => {
      try {
        const assignments = await fetchAllPages<RoleManagementPolicyAssignmentApi>(
          `https://management.azure.com${scope}/providers/Microsoft.Authorization/roleManagementPolicyAssignments?api-version=2020-10-01`,
          token
        );
        return [scope, buildRolePolicyRequirementMap(assignments)] as const;
      } catch {
        return [scope, {}] as const;
      }
    })
  );
  const requirementsByScope = Object.fromEntries(policyEntries);

  return items.map((item) => {
    if (item.type !== "azureRole") {
      return item;
    }

    const requirements = requirementsByScope[item.scope]?.[item.roleDefinitionId.toLowerCase()];
    return applyActivationRequirements(item, requirements);
  });
}

async function getSubscriptions(token: string): Promise<Array<{ subscriptionId: string; displayName: string }>> {
  const data = await fetchJson<{ value?: Array<{ subscriptionId: string; displayName: string }> }>(
    "https://management.azure.com/subscriptions?api-version=2020-01-01",
    token
  );
  return data.value || [];
}

async function getActiveDirectoryRoles(graphToken: string): Promise<ActivationItem[]> {
  assertFreshToken(graphToken, "graph");
  const roles = await fetchAllPages<DirectoryRoleApi & { action?: string; status?: string; scheduleInfo?: any }>(
    "https://graph.microsoft.com/v1.0/roleManagement/directory/roleAssignmentScheduleRequests/filterByCurrentUser(on='principal')",
    graphToken
  );
  const definitions = await getDirectoryRoleDefinitionsBestEffort(graphToken);
  const now = Date.now();

  return roles
    .filter((role) => role.action === "selfActivate" && ["Provisioned", "Granted"].includes(role.status || ""))
    .map((role) => {
      const startDateTime = role.scheduleInfo?.startDateTime;
      const duration = role.scheduleInfo?.expiration?.duration;
      const endTime = startDateTime && duration ? new Date(startDateTime).getTime() + parseIsoDurationMs(duration) : 0;
      return { role, endTime };
    })
    .filter(({ endTime }) => !endTime || endTime > now)
    .map(({ role }) => ({
      ...normalizeDirectoryRole(withDirectoryRoleDefinitionName(role, definitions)),
      status: "active" as const
    }));
}

async function getActiveAzureRoles(azureManagementToken: string): Promise<ActivationItem[]> {
  assertFreshToken(azureManagementToken, "azureManagement");
  const subscriptions = await getSubscriptions(azureManagementToken);
  const now = Date.now();
  const roleGroups = await Promise.allSettled(
    subscriptions.map(async (subscription) => {
      const roles = await fetchAllPages<AzureRoleApi>(
        `https://management.azure.com/subscriptions/${subscription.subscriptionId}/providers/Microsoft.Authorization/roleAssignmentScheduleInstances?api-version=2020-10-01&$filter=asTarget()`,
        azureManagementToken
      );
      return roles
        .filter((role) => !role.properties?.endDateTime || new Date(role.properties.endDateTime).getTime() > now)
        .map((role) => ({
          ...normalizeAzureRole({
            ...role,
            subscriptionId: subscription.subscriptionId,
            subscriptionName: subscription.displayName
          }),
          status: "active" as const
        }));
    })
  );

  return applyAzureRoleDefinitionNames(
    roleGroups.flatMap((group) => (group.status === "fulfilled" ? group.value : [])),
    azureManagementToken
  );
}

async function applyAzureRoleDefinitionNames(items: ActivationItem[], token: string): Promise<ActivationItem[]> {
  const azureItems = items.filter((item): item is Extract<ActivationItem, { type: "azureRole" }> => item.type === "azureRole");
  const unresolvedDefinitionIds = [
    ...new Set(
      azureItems
        .filter((item) => item.displayName === item.roleDefinitionId.split("/").at(-1))
        .map((item) => item.roleDefinitionId)
    )
  ];

  if (!unresolvedDefinitionIds.length) {
    return items;
  }

  const definitions = Object.fromEntries(
    await Promise.all(
      unresolvedDefinitionIds.map(async (roleDefinitionId) => {
        try {
          const definition = await fetchJson<{ properties?: { roleName?: string } }>(
            `https://management.azure.com${roleDefinitionId}?api-version=2022-04-01`,
            token
          );
          return [roleDefinitionId, definition.properties?.roleName || roleDefinitionId.split("/").at(-1) || roleDefinitionId] as const;
        } catch {
          return [roleDefinitionId, roleDefinitionId.split("/").at(-1) || roleDefinitionId] as const;
        }
      })
    )
  );

  return items.map((item) => {
    if (item.type !== "azureRole") {
      return item;
    }
    const displayName = definitions[item.roleDefinitionId];
    return displayName ? { ...item, sourceName: displayName, displayName } : item;
  });
}

async function getActivePimGroups(graphToken: string): Promise<ActivationItem[]> {
  assertFreshToken(graphToken, "graph");
  const schedules = await fetchAllPages<PimGroupApi>(
    "https://graph.microsoft.com/v1.0/identityGovernance/privilegedAccess/group/assignmentSchedules/filterByCurrentUser(on='principal')",
    graphToken
  );
  const groupInfos = await getGroupInfos(
    graphToken,
    [...new Set(schedules.map((schedule) => schedule.groupId).filter(Boolean) as string[])]
  );
  return schedules.map((schedule) => ({ ...normalizePimGroup(schedule, groupInfos[schedule.groupId || ""]), status: "active" }));
}

async function activateItems(
  items: ActivationItem[],
  durationHours: number,
  justification: string,
  ticketInfo: TicketInfo
): Promise<ActivationResponse> {
  if (!items.length) {
    throw new Error("Select at least one item to activate.");
  }
  const requiresJustification = items.some((item) => item.activationRequirements?.justification !== false);
  if (requiresJustification && !justification.trim()) {
    throw new Error("A justification is required.");
  }
  if (durationHours <= 0) {
    throw new Error("Duration must be greater than 0.");
  }

  const tokens = await getStoredTokens();
  const startDateTime = new Date().toISOString();
  const results = await Promise.all(
    items.map(async (item) => {
      try {
        const request = buildActivationRequest(item, durationHours, justification.trim(), ticketInfo, startDateTime);
        const token = request.tokenKind === "graph" ? tokens.graphToken : tokens.azureManagementToken;
        if (!token) {
          throw new Error(request.tokenKind === "graph" ? "Graph token is missing." : "Azure Management token is missing.");
        }

        const response = await fetch(request.endpoint, {
          method: request.method,
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(request.body)
        });

        if (!response.ok) {
          const errorData = await safeJson(response);
          throw new Error(errorData?.error?.message || `${response.status} ${response.statusText}`);
        }

        const data = await safeJson(response);
        return {
          itemId: item.id,
          itemName: item.displayName,
          success: true,
          requestId: data?.id || data?.name
        };
      } catch (error) {
        return {
          itemId: item.id,
          itemName: item.displayName,
          success: false,
          error: error instanceof Error ? error.message : String(error)
        };
      }
    })
  );

  const errors = results.filter((result) => !result.success);
  return {
    success: errors.length === 0,
    results,
    errors
  };
}

async function fetchAllPages<T>(url: string, token: string): Promise<T[]> {
  const values: T[] = [];
  let nextUrl: string | undefined = url;

  while (nextUrl) {
    const data: { value?: T[]; "@odata.nextLink"?: string; nextLink?: string } = await fetchJson(nextUrl, token);
    values.push(...(data.value || []));
    nextUrl = data["@odata.nextLink"] || data.nextLink;
  }

  return values;
}

async function fetchJson<T>(url: string, token: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    }
  });

  if (!response.ok) {
    const errorData = await safeJson(response);
    throw new Error(errorData?.error?.message || `${response.status} ${response.statusText}`);
  }

  return (await response.json()) as T;
}

async function safeJson(response: Response): Promise<any> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function dedupeItems(items: ActivationItem[]): ActivationItem[] {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

function buildRolePolicyRequirementMap(
  assignments: RoleManagementPolicyAssignmentApi[]
): Record<string, Partial<ActivationRequirements>> {
  const entries = assignments.flatMap((assignment) => {
    const roleDefinitionId = getPolicyAssignmentRoleDefinitionId(assignment);
    const rules = getPolicyAssignmentRules(assignment);
    if (!roleDefinitionId || !rules.length) {
      return [];
    }
    return [[roleDefinitionId.toLowerCase(), extractActivationRequirementsFromPolicyRules(rules)] as const];
  });
  return Object.fromEntries(entries);
}

function getPolicyAssignmentRoleDefinitionId(assignment: RoleManagementPolicyAssignmentApi): string {
  return assignment.roleDefinitionId || assignment.properties?.roleDefinitionId || "";
}

function getPolicyAssignmentRules(assignment: RoleManagementPolicyAssignmentApi) {
  return (
    assignment.policy?.rules ||
    assignment.policy?.effectiveRules ||
    assignment.properties?.effectiveRules ||
    assignment.properties?.policy?.rules ||
    assignment.properties?.policy?.effectiveRules ||
    []
  );
}

function requirePrincipalId(token: string): string {
  const decoded = decodeToken(token);
  const principalId = decoded?.oid;
  if (!principalId) {
    throw new Error("Could not determine the signed-in principal from the captured token.");
  }
  return principalId;
}
