import type { QuickPimSettings, TokenStatus } from "./types";

export type PermissionCategory = "graph" | "azure";

export interface RequiredPermissionItem {
  id: string;
  category: PermissionCategory;
  name: string;
  requiredAnyOf: string[];
  missingImpact: string;
  docsUrl?: string;
  note?: string;
}

export interface PermissionStatusItem extends RequiredPermissionItem {
  isPresent: boolean;
  matchedBy?: string;
}

const GRAPH_SCOPE_DOCS = "https://learn.microsoft.com/en-us/graph/permissions-reference";
const PIM_GROUP_READ_SCOPES = ["PrivilegedAccess.Read.AzureADGroup", "PrivilegedAccess.ReadWrite.AzureADGroup"];
const PIM_GROUP_WRITE_SCOPES = ["PrivilegedAccess.ReadWrite.AzureADGroup"];

export const REQUIRED_PERMISSION_ITEMS: RequiredPermissionItem[] = [
  {
    id: "graph.token",
    category: "graph",
    name: "Microsoft Graph access token",
    requiredAnyOf: ["captured Graph token"],
    missingImpact: "QuickPIM cannot read or activate Entra roles or PIM groups.",
    note: "Captured automatically when you browse Microsoft Graph-backed Entra or Azure Portal pages."
  },
  {
    id: "azure.token",
    category: "azure",
    name: "Azure Management access token",
    requiredAnyOf: ["captured Azure Management token"],
    missingImpact: "Azure role eligibility, active role state, policy limits, and activation will not work.",
    note: "Captured automatically when Azure Portal calls management.azure.com."
  },
  {
    id: "graph.entraRoles.read",
    category: "graph",
    name: "Read eligible Entra roles",
    requiredAnyOf: [
      "RoleEligibilitySchedule.Read.Directory",
      "RoleEligibilitySchedule.ReadWrite.Directory",
      "RoleManagement.Read.All",
      "RoleManagement.Read.Directory",
      "RoleManagement.ReadWrite.Directory"
    ],
    missingImpact: "The Entra Roles tab cannot list eligible directory roles.",
    docsUrl: "https://learn.microsoft.com/en-us/graph/api/rbacapplication-list-roleeligibilityschedules?view=graph-rest-1.0"
  },
  {
    id: "graph.entraRoles.activate",
    category: "graph",
    name: "Activate Entra roles",
    requiredAnyOf: ["RoleAssignmentSchedule.ReadWrite.Directory", "RoleManagement.ReadWrite.Directory"],
    missingImpact: "QuickPIM cannot activate Entra roles or read current Entra activation requests.",
    docsUrl: "https://learn.microsoft.com/en-us/graph/api/rbacapplication-post-roleassignmentschedulerequests?view=graph-rest-1.0"
  },
  {
    id: "graph.entraRoles.active",
    category: "graph",
    name: "Read active Entra role requests",
    requiredAnyOf: ["RoleAssignmentSchedule.ReadWrite.Directory", "RoleManagement.ReadWrite.Directory"],
    missingImpact: "The Active tab cannot show current Entra role activations.",
    docsUrl: "https://learn.microsoft.com/en-us/graph/api/unifiedroleassignmentschedulerequest-filterbycurrentuser?view=graph-rest-1.0"
  },
  {
    id: "graph.policies.read",
    category: "graph",
    name: "Read PIM policy settings",
    requiredAnyOf: [
      "RoleManagementPolicy.Read.Directory",
      "RoleManagementPolicy.ReadWrite.Directory",
      "RoleManagement.Read.All",
      "RoleManagement.Read.Directory",
      "RoleManagement.ReadWrite.Directory"
    ],
    missingImpact: "Role-specific duration caps, ticket requirements, and justification requirements may be incomplete.",
    docsUrl: "https://learn.microsoft.com/en-us/graph/api/policyroot-list-rolemanagementpolicyassignments?view=graph-rest-beta"
  },
  {
    id: "graph.pimGroups.read",
    category: "graph",
    name: "Read eligible PIM groups",
    requiredAnyOf: [
      "PrivilegedEligibilitySchedule.Read.AzureADGroup",
      "PrivilegedEligibilitySchedule.ReadWrite.AzureADGroup",
      ...PIM_GROUP_READ_SCOPES
    ],
    missingImpact: "The PIM Groups tab cannot list eligible groups.",
    docsUrl: "https://learn.microsoft.com/en-us/graph/api/privilegedaccessgroupeligibilityschedule-filterbycurrentuser?view=graph-rest-1.0"
  },
  {
    id: "graph.pimGroups.active",
    category: "graph",
    name: "Read active PIM group assignments",
    requiredAnyOf: [
      "PrivilegedAssignmentSchedule.Read.AzureADGroup",
      "PrivilegedAssignmentSchedule.ReadWrite.AzureADGroup",
      ...PIM_GROUP_READ_SCOPES
    ],
    missingImpact: "The Active tab cannot show active PIM group assignments.",
    docsUrl: "https://learn.microsoft.com/en-us/graph/api/privilegedaccessgroupassignmentschedule-filterbycurrentuser?view=graph-rest-1.0"
  },
  {
    id: "graph.pimGroups.activate",
    category: "graph",
    name: "Activate PIM groups",
    requiredAnyOf: ["PrivilegedAssignmentSchedule.ReadWrite.AzureADGroup", ...PIM_GROUP_WRITE_SCOPES],
    missingImpact: "QuickPIM cannot activate PIM group member or owner assignments.",
    docsUrl: "https://learn.microsoft.com/en-us/graph/api/privilegedaccessgroup-post-assignmentschedulerequests?view=graph-rest-1.0"
  },
  {
    id: "graph.pimGroups.policy",
    category: "graph",
    name: "Read PIM group policy settings",
    requiredAnyOf: [
      "RoleManagementPolicy.Read.AzureADGroup",
      "RoleManagementPolicy.ReadWrite.AzureADGroup",
      ...PIM_GROUP_READ_SCOPES
    ],
    missingImpact: "PIM group duration caps, ticket requirements, and justification requirements may be incomplete.",
    docsUrl: "https://learn.microsoft.com/en-us/graph/permissions-reference"
  },
  {
    id: "graph.groups.resolveNames",
    category: "graph",
    name: "Resolve PIM group display names",
    requiredAnyOf: [
      "GroupMember.Read.All",
      "Group.Read.All",
      "Group.ReadWrite.All",
      "Directory.Read.All",
      "Directory.ReadWrite.All"
    ],
    missingImpact: "PIM groups may display as opaque group IDs instead of friendly names.",
    docsUrl: "https://learn.microsoft.com/en-us/graph/api/group-get?view=graph-rest-1.0"
  },
  {
    id: "azure.roles.rbac",
    category: "azure",
    name: "Azure RBAC rights for PIM role APIs",
    requiredAnyOf: [
      "Microsoft.Authorization/roleEligibilityScheduleInstances/read",
      "Microsoft.Authorization/roleAssignmentScheduleInstances/read",
      "Microsoft.Authorization/roleAssignmentScheduleRequests/write",
      "Microsoft.Authorization/roleManagementPolicyAssignments/read"
    ],
    missingImpact: "Azure Roles can fail to list, cap durations, show active assignments, or activate.",
    docsUrl: "https://learn.microsoft.com/en-us/rest/api/authorization/role-eligibility-schedule-instances/list-for-scope?view=rest-authorization-2020-10-01",
    note: "Azure RBAC actions are enforced by your Azure role assignments, not by Graph OAuth scopes. QuickPIM marks this available when an Azure Management token is captured; a 403 from Azure still means the signed-in account needs RBAC rights at the relevant scope."
  }
];

export function buildPermissionStatus(tokenStatus: TokenStatus | null | undefined): PermissionStatusItem[] {
  const graphScopes = new Set(tokenStatus?.graph.grantedScopes || []);
  const azureScopes = new Set(tokenStatus?.azureManagement.grantedScopes || []);
  const hasGraphToken = Boolean(tokenStatus?.graph.hasToken && !tokenStatus.graph.isExpired);
  const hasAzureToken = Boolean(tokenStatus?.azureManagement.hasToken && !tokenStatus.azureManagement.isExpired);

  return REQUIRED_PERMISSION_ITEMS.map((item) => {
    if (item.id === "graph.token") {
      return { ...item, isPresent: hasGraphToken, matchedBy: hasGraphToken ? "captured Graph token" : undefined };
    }
    if (item.id === "azure.token") {
      return { ...item, isPresent: hasAzureToken, matchedBy: hasAzureToken ? "captured Azure Management token" : undefined };
    }
    if (item.id === "azure.roles.rbac") {
      return { ...item, isPresent: hasAzureToken, matchedBy: hasAzureToken ? "Azure Management token captured" : undefined };
    }

    const grantedScopes = item.category === "azure" ? azureScopes : graphScopes;
    const matchedBy = item.requiredAnyOf.find((scope) => grantedScopes.has(scope));
    return {
      ...item,
      isPresent: Boolean(matchedBy),
      matchedBy
    };
  });
}

export function getMissingPermissionItems(status: PermissionStatusItem[]): PermissionStatusItem[] {
  return status.filter((item) => !item.isPresent);
}

export function shouldShowPermissionWarning(status: PermissionStatusItem[], settings: QuickPimSettings): boolean {
  return !settings.preferences.permissionWarningIgnored && getMissingPermissionItems(status).length > 0;
}

export const permissionSetupPowerShell = String.raw`# QuickPIM permission helper for a custom/manual-token app registration.
# This appends Microsoft Graph delegated scopes; it does not replace existing API permissions.
Install-Module Microsoft.Graph -Scope CurrentUser
Connect-MgGraph -Scopes "Application.ReadWrite.All"

$clientAppId = "<your-client-app-id>"
$app = Get-MgApplication -Filter "appId eq '$clientAppId'"
if (-not $app) {
  throw "Application registration with appId $clientAppId was not found."
}

$graphSp = Get-MgServicePrincipal -Filter "appId eq '00000003-0000-0000-c000-000000000000'"

$requiredScopes = @(
  "RoleEligibilitySchedule.Read.Directory",
  "RoleAssignmentSchedule.ReadWrite.Directory",
  "RoleManagementPolicy.Read.Directory",
  "RoleManagementPolicy.Read.AzureADGroup",
  "PrivilegedEligibilitySchedule.Read.AzureADGroup",
  "PrivilegedAssignmentSchedule.Read.AzureADGroup",
  "PrivilegedAssignmentSchedule.ReadWrite.AzureADGroup",
  "GroupMember.Read.All"
)

$scopeAccess = foreach ($scope in $requiredScopes) {
  $oauthScope = $graphSp.Oauth2PermissionScopes | Where-Object { $_.Value -eq $scope }
  if (-not $oauthScope) {
    Write-Warning "Microsoft Graph delegated scope $scope was not found in this tenant."
    continue
  }

  [Microsoft.Graph.PowerShell.Models.MicrosoftGraphResourceAccess]@{
    Id = $oauthScope.Id
    Type = "Scope"
  }
}

$existingResourceAccess = @($app.RequiredResourceAccess)
$graphAccess = $existingResourceAccess | Where-Object { $_.ResourceAppId -eq $graphSp.AppId }
$otherAccess = $existingResourceAccess | Where-Object { $_.ResourceAppId -ne $graphSp.AppId }

if ($graphAccess) {
  $mergedAccess = @($graphAccess.ResourceAccess + $scopeAccess) |
    Sort-Object Id -Unique
} else {
  $mergedAccess = $scopeAccess
}

$updatedGraphAccess = [Microsoft.Graph.PowerShell.Models.MicrosoftGraphRequiredResourceAccess]@{
  ResourceAppId = $graphSp.AppId
  ResourceAccess = $mergedAccess
}

Update-MgApplication -ApplicationId $app.Id -RequiredResourceAccess @($otherAccess + $updatedGraphAccess)
Write-Host "Permissions appended. Grant admin consent in Entra admin center for app $clientAppId."`;

export const permissionSetupTutorial = [
  "QuickPIM normally uses tokens captured from Microsoft first-party portals. Open the matching Entra or Azure PIM blades and refresh QuickPIM after the portal has requested the needed scopes.",
  "If you use a manually supplied token from your own app registration, append the missing delegated Microsoft Graph scopes instead of replacing existing API permissions.",
  "After changing app permissions, grant admin consent and sign in again so the captured token contains the new scopes.",
  "Azure resource PIM also depends on Azure RBAC permissions at the subscription, resource group, or resource scope. OAuth scopes alone do not grant Azure RBAC actions."
];

export const permissionDocsUrl = GRAPH_SCOPE_DOCS;
