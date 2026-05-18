export type ActivationItemType = "directoryRole" | "azureRole" | "pimGroup";
export type ActivationStatus = "eligible" | "active";
export type SortMode = "name" | "lastUsed" | "activationCount" | "type" | "scope";
export type TokenKind = "graph" | "azureManagement";

export interface UsageStats {
  activationCount: number;
  lastUsedAt?: string;
}

export interface TicketInfo {
  ticketSystem?: string;
  ticketNumber?: string;
}

export interface BaseActivationItem {
  id: string;
  type: ActivationItemType;
  sourceName: string;
  displayName: string;
  principalId: string;
  scopeLabel: string;
  status: ActivationStatus;
  activationRequirements?: {
    justification?: boolean;
    ticket?: boolean;
  };
  raw?: unknown;
}

export interface DirectoryRoleItem extends BaseActivationItem {
  type: "directoryRole";
  roleDefinitionId: string;
  directoryScopeId: string;
}

export interface AzureRoleItem extends BaseActivationItem {
  type: "azureRole";
  roleDefinitionId: string;
  scope: string;
  subscriptionId?: string;
  subscriptionName?: string;
  roleEligibilityScheduleId?: string;
}

export interface PimGroupItem extends BaseActivationItem {
  type: "pimGroup";
  groupId: string;
  accessId: "member" | "owner";
  memberType?: string;
}

export type ActivationItem = DirectoryRoleItem | AzureRoleItem | PimGroupItem;

export interface QuickPimBundle {
  id: string;
  name: string;
  itemIds: string[];
  defaultDurationHours?: number;
  defaultJustification?: string;
  defaultTicketSystem?: string;
  defaultTicketNumber?: string;
}

export interface ActivationHistoryEntry {
  id: string;
  itemId: string;
  itemName: string;
  itemType: ActivationItemType;
  bundleName?: string;
  activatedAt: string;
}

export interface QuickPimPreferences {
  defaultDurationHours: number;
  defaultSort: SortMode;
  recentJustificationLimit: number;
}

export interface CachedActivationEntry {
  items: ActivationItem[];
  errors: string[];
  fetchedAt: number;
}

export interface QuickPimDataCache {
  eligible?: CachedActivationEntry;
  active?: CachedActivationEntry;
}

export interface QuickPimSettings {
  version: 1;
  aliasesByItemId: Record<string, string>;
  savedJustifications: string[];
  recentJustifications: string[];
  bundles: QuickPimBundle[];
  usageStatsByItemId: Record<string, UsageStats>;
  activationHistory: ActivationHistoryEntry[];
  preferences: QuickPimPreferences;
}

export interface TokenStatusEntry {
  hasToken: boolean;
  tokenAge?: number;
  expiresAt?: string;
  expiresInMinutes?: number;
  isExpired?: boolean;
  source?: string;
}

export interface TokenStatus {
  graph: TokenStatusEntry;
  azureManagement: TokenStatusEntry;
}

export interface ActivationRequest {
  endpoint: string;
  method: "POST" | "PUT";
  tokenKind: TokenKind;
  body: Record<string, unknown>;
}

export interface ActivationResult {
  itemId: string;
  itemName: string;
  success: boolean;
  requestId?: string;
  error?: string;
}

export interface ActivationResponse {
  success: boolean;
  results: ActivationResult[];
  errors: ActivationResult[];
}

export interface BundleExpansion {
  items: ActivationItem[];
  durationHours?: number;
  justification?: string;
  ticketInfo: TicketInfo;
}

export interface DirectoryRoleApi {
  id?: string;
  roleDefinitionId?: string;
  principalId?: string;
  directoryScopeId?: string;
  roleName?: string;
  roleDefinitionDisplayName?: string;
  roleDefinition?: {
    id?: string;
    displayName?: string;
    templateId?: string;
  };
}

export interface DirectoryRoleDefinitionApi {
  id?: string;
  templateId?: string;
  displayName?: string;
}

export interface AzureRoleApi {
  id?: string;
  name?: string;
  subscriptionId?: string;
  subscriptionName?: string;
  properties?: {
    principalId?: string;
    roleDefinitionId?: string;
    roleEligibilityScheduleId?: string;
    scope?: string;
    endDateTime?: string;
    expandedProperties?: {
      roleDefinition?: {
        id?: string;
        displayName?: string;
        type?: string;
      };
      scope?: {
        id?: string;
        displayName?: string;
        type?: string;
      };
    };
  };
  roleDefinitionId?: string;
  principalId?: string;
  roleName?: string;
}

export interface PimGroupApi {
  id?: string;
  groupId?: string;
  principalId?: string;
  accessId?: "member" | "owner";
  memberType?: string;
}

export interface GroupInfo {
  id?: string;
  displayName?: string;
  description?: string;
  mail?: string;
}
