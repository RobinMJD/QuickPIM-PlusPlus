export interface AzureRoleDefinitionForPrivilege {
  properties?: {
    permissions?: Array<{
      actions?: string[];
      dataActions?: string[];
    }>;
  };
}

const PRIVILEGED_AZURE_ROLE_ACTIONS = new Set([
  "*",
  "*/delete",
  "*/write",
  "Microsoft.Authorization/denyAssignments/delete",
  "Microsoft.Authorization/denyAssignments/write",
  "Microsoft.Authorization/roleAssignments/delete",
  "Microsoft.Authorization/roleAssignments/write",
  "Microsoft.Authorization/roleDefinitions/delete",
  "Microsoft.Authorization/roleDefinitions/write"
]);

export function isPrivilegedAzureRoleDefinition(definition: AzureRoleDefinitionForPrivilege): boolean {
  return (definition.properties?.permissions || []).some((permission) =>
    [...(permission.actions || []), ...(permission.dataActions || [])].some((action) => PRIVILEGED_AZURE_ROLE_ACTIONS.has(action))
  );
}
