export type ActivationItemType = "directoryRole" | "azureRole" | "pimGroup";
export type ActivationStatus = "eligible" | "active" | "pendingApproval";
export type SortMode = "name" | "lastUsed" | "activationCount" | "type" | "scope";
export type RoleTab = ActivationItemType;
export type PopupTab = RoleTab | "bundles";
export type QuickPimFeature = PopupTab;
export type TokenKind = "graph" | "azureManagement";
export type AccessSetupTarget = ActivationItemType;
export type AccessCapabilityStatus = "ready" | "needsPortalRefresh" | "limited";
export type PopupRequestMode = "activate" | "deactivate";
export type AccessDiagnosticOperation = "eligible" | "active" | "policy" | "nameLookup" | "activation" | "deactivation";
export type AccessFailureKind = "missingToken" | "expiredToken" | "missingCapability" | "forbidden" | "claimsChallenge" | "network" | "unknown";

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
  sourceScopeLabel?: string;
  status: ActivationStatus;
  activeUntil?: string;
  assignmentScheduleId?: string;
  assignmentScheduleInstanceId?: string;
  isPrivileged?: boolean;
  activationRequirements?: {
    justification?: boolean;
    ticket?: boolean;
    approval?: boolean;
    maxDurationHours?: number;
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
}

export interface ActivationHistoryEntry {
  id: string;
  itemId: string;
  itemName: string;
  itemType: ActivationItemType;
  bundleName?: string;
  activatedAt: string;
}

export type ActivityAction = "activate" | "deactivate";
export type ActivityResult = "success" | "failed" | "skipped";

export interface ActivityHistoryEntry {
  id: string;
  action: ActivityAction;
  result: ActivityResult;
  itemId: string;
  itemName: string;
  itemType: ActivationItemType;
  scopeLabel?: string;
  requestedAt: string;
  completedAt?: string;
  durationHours?: number;
  bundleName?: string;
  justification?: string;
  error?: string;
}

export interface QuickPimPreferences {
  defaultDurationHours: number;
  defaultSort: SortMode;
  recentJustificationLimit: number;
  activityHistoryLimit: number;
  darkMode: boolean;
  showActivationCounters: boolean;
  showEnablementDetails: boolean;
  showLastEnablementDate: boolean;
  backgroundPreRefreshEnabled: boolean;
  enabledFeatures: QuickPimFeature[];
  autoEnabledFeaturesInitialized?: boolean;
  hiddenPopupTabs?: PopupTab[];
  permissionWarningIgnored?: boolean;
  permissionWarningIgnoredAt?: string;
}

export interface CachedActivationEntry {
  items: ActivationItem[];
  errors: string[];
  fetchedAt: number;
  cacheKey?: string;
  diagnostics?: AccessDiagnostic[];
}

export type TargetActivationCache = Partial<Record<AccessSetupTarget, CachedActivationEntry>>;

export interface QuickPimDataCache {
  eligible?: CachedActivationEntry;
  active?: CachedActivationEntry;
  eligibleByTarget?: TargetActivationCache;
  activeByTarget?: TargetActivationCache;
}

export interface AccessDiagnostic {
  target: AccessSetupTarget;
  success: boolean;
  checkedAt: string;
  error?: string;
  fromCache?: boolean;
  operation?: AccessDiagnosticOperation;
  endpointLabel?: string;
  failureKind?: AccessFailureKind;
}

export interface ReferenceValue {
  name: string;
  updatedAt: string;
}

export interface ReferenceDataCache {
  version: 1;
  directoryRoleDefinitions: Record<string, ReferenceValue>;
  pimGroups: Record<string, ReferenceValue>;
  azureRoleDefinitions: Record<string, ReferenceValue>;
  azureSubscriptions: Record<string, ReferenceValue>;
  scopes: Record<string, ReferenceValue>;
  directoryScopes: Record<string, ReferenceValue>;
}

export interface QuickPimSettings {
  version: 2;
  aliasesByItemId: Record<string, string>;
  favoriteItemIds: string[];
  savedJustifications: string[];
  recentJustifications: string[];
  bundles: QuickPimBundle[];
  usageStatsByItemId: Record<string, UsageStats>;
  activityHistory: ActivityHistoryEntry[];
  activationHistory: ActivationHistoryEntry[];
  preferences: QuickPimPreferences;
}

export interface TokenStatusEntry {
  hasToken: boolean;
  tenantId?: string;
  principalId?: string;
  capturedAt?: number;
  tokenAge?: number;
  expiresAt?: string;
  expiresInMinutes?: number;
  isExpired?: boolean;
  source?: string;
  grantedScopes?: string[];
}

export interface TokenStatus {
  graph: TokenStatusEntry;
  graphTargets?: Partial<Record<Exclude<AccessSetupTarget, "azureRole">, TokenStatusEntry>>;
  azureManagement: TokenStatusEntry;
}

export interface PortalTokenRefreshResult {
  tokenStatus: TokenStatus;
  tabsFound: number;
  tabsScanned: number;
  captured: TokenKind[];
}

export interface ActivationDataResult {
  items: ActivationItem[];
  errors: string[];
  diagnostics?: AccessDiagnostic[];
}

export interface ActivationSnapshot {
  eligible: ActivationDataResult;
  active: ActivationDataResult;
  eligibleByTarget?: Partial<Record<AccessSetupTarget, ActivationDataResult>>;
  activeByTarget?: Partial<Record<AccessSetupTarget, ActivationDataResult>>;
  tokenStatus?: TokenStatus;
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
  action?: string;
  status?: string;
  targetScheduleId?: string;
  roleAssignmentScheduleId?: string;
  roleEligibilityScheduleId?: string;
  roleAssignmentOriginId?: string;
  assignmentType?: string;
  memberType?: string;
  startDateTime?: string;
  endDateTime?: string;
  scheduleInfo?: unknown;
  directoryScopeDisplayName?: string;
  directoryScope?: {
    id?: string;
    displayName?: string;
  };
  roleDefinitionDisplayName?: string;
  roleDefinition?: {
    id?: string;
    displayName?: string;
    templateId?: string;
    isPrivileged?: boolean;
  };
  isPrivileged?: boolean;
}

export interface DirectoryRoleDefinitionApi {
  id?: string;
  templateId?: string;
  displayName?: string;
  isPrivileged?: boolean;
}

export interface RoleManagementPolicyRuleApi {
  id?: string;
  ruleType?: string;
  maximumDuration?: string;
  enabledRules?: string[];
  target?: {
    caller?: string;
    level?: string;
  };
  setting?: {
    isRequestorJustificationRequired?: boolean;
    isApprovalRequired?: boolean;
    approvalMode?: string;
    approvalStages?: unknown[];
  };
}

export interface RoleManagementPolicyAssignmentApi {
  id?: string;
  roleDefinitionId?: string;
  scopeId?: string;
  policy?: {
    rules?: RoleManagementPolicyRuleApi[];
    effectiveRules?: RoleManagementPolicyRuleApi[];
  };
  properties?: {
    roleDefinitionId?: string;
    scope?: string;
    effectiveRules?: RoleManagementPolicyRuleApi[];
    policy?: {
      rules?: RoleManagementPolicyRuleApi[];
      effectiveRules?: RoleManagementPolicyRuleApi[];
    };
  };
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
    roleAssignmentScheduleId?: string;
    roleAssignmentScheduleInstanceId?: string;
    linkedRoleEligibilityScheduleId?: string;
    linkedRoleEligibilityScheduleInstanceId?: string;
    scope?: string;
    endDateTime?: string;
    assignmentType?: string;
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
  action?: string;
  status?: string;
  targetScheduleId?: string;
  assignmentScheduleId?: string;
  eligibilityScheduleId?: string;
  assignmentType?: string;
  memberType?: string;
  endDateTime?: string;
  scheduleInfo?: {
    startDateTime?: string;
    expiration?: {
      type?: string;
      duration?: string;
      endDateTime?: string;
    };
  };
}

export interface GroupInfo {
  id?: string;
  displayName?: string;
  description?: string;
  mail?: string;
}
