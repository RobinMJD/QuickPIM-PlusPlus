export type ActivationItemType = "directoryRole" | "azureRole" | "pimGroup";
export type ActivationStatus = "eligible" | "active" | "pendingApproval";
export type ActiveAssignmentType = "activated" | "assigned" | "unknown";
export type SortMode = "name" | "lastUsed" | "activationCount" | "scope";
export type SortDirection = "ascending" | "descending";
export type RoleTab = ActivationItemType;
export type PopupTab = RoleTab | "bundles";
export type QuickPimFeature = PopupTab;
export type TokenKind = "graph" | "azureManagement";
export type AccessSetupTarget = ActivationItemType;
export type AccessCapabilityStatus = "ready" | "needsPortalRefresh" | "limited";
export type PortalRecoveryState = "idle" | "waiting" | "interactionRequired";
export type PortalRecoveryInteractionReason = "signIn" | "microsoftPrompt";
export type PopupRequestMode = "activate" | "deactivate";
export type AccessDiagnosticOperation = "eligible" | "active" | "policy" | "nameLookup" | "activation" | "deactivation";
export type AccessFailureKind = "missingToken" | "expiredToken" | "missingCapability" | "forbidden" | "claimsChallenge" | "network" | "unknown";
export type ActivationPolicyState = "pending" | "ready";

export interface UsageStats {
  activationCount: number;
  lastUsedAt?: string;
  legacyActivationCount?: number;
  byInstallationId?: Record<string, InstallationUsageStats>;
}

export interface InstallationUsageStats {
  activationCount: number;
  lastUsedAt?: string;
}

export interface ActivitySource {
  installationId: string;
  deviceName: string;
}

export interface TicketInfo {
  ticketSystem?: string;
  ticketNumber?: string;
}

export interface BaseActivationItem {
  id: string;
  type: ActivationItemType;
  tenantId?: string;
  sourceName: string;
  displayName: string;
  principalId: string;
  scopeLabel: string;
  sourceScopeLabel?: string;
  status: ActivationStatus;
  activeAssignmentType?: ActiveAssignmentType;
  activeUntil?: string;
  assignmentScheduleId?: string;
  assignmentScheduleInstanceId?: string;
  isPrivileged?: boolean;
  activationPolicyState?: ActivationPolicyState;
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
  tenantId?: string;
  bundleName?: string;
  activatedAt: string;
}

export type ActivityAction = "activate" | "deactivate";
export type ActivityResult = "success" | "failed" | "skipped";
export type TrackedPimRequestStatus =
  | "submitted"
  | "pendingApproval"
  | "provisioning"
  | "scheduled"
  | "active"
  | "completed"
  | "denied"
  | "failed"
  | "canceled"
  | "expired"
  | "unknown"
  | "statusUnavailable";

export interface ActivityHistoryEntry {
  id: string;
  action: ActivityAction;
  result: ActivityResult;
  itemId: string;
  itemName: string;
  itemType: ActivationItemType;
  tenantId?: string;
  scopeLabel?: string;
  requestedAt: string;
  completedAt?: string;
  durationHours?: number;
  bundleName?: string;
  justification?: string;
  error?: string;
  sourceInstallationId?: string;
  sourceDeviceName?: string;
}

export interface TrackedPimRequest {
  id: string;
  requestId: string;
  operationId?: string;
  action: ActivityAction;
  itemId: string;
  itemName: string;
  itemType: ActivationItemType;
  scopeLabel?: string;
  principalId: string;
  tenantId?: string;
  roleDefinitionId?: string;
  directoryScopeId?: string;
  groupId?: string;
  accessId?: "member" | "owner";
  azureScope?: string;
  status: TrackedPimRequestStatus;
  rawStatus?: string;
  requestedAt: string;
  updatedAt: string;
  completedAt?: string;
  activeUntil?: string;
  activeFrom?: string;
  durationHours?: number;
  justification?: string;
  ticketSystem?: string;
  ticketNumber?: string;
  bundleName?: string;
  roleEligibilityScheduleId?: string;
  activationRequirements?: BaseActivationItem["activationRequirements"];
  continuationOfRequestId?: string;
  extensionAttemptState?: "submitting" | "queued" | "uncertain";
  extensionRequestedAt?: string;
  extensionRequestId?: string;
  extensionLastError?: string;
  approvalId?: string;
  targetScheduleId?: string;
  activeAssignmentMissingSince?: string;
  lastCheckedAt?: string;
  nextCheckAt?: string;
  checkCount: number;
  lastError?: string;
  notifiedStatus?: TrackedPimRequestStatus;
  expiryReminderAttemptedAt?: string;
  expiryReminderSentAt?: string;
  notificationLastAttemptAt?: string;
  notificationLastError?: string;
  sourceInstallationId?: string;
  sourceDeviceName?: string;
}

export interface TrackedPimRequestStore {
  version: 1;
  requests: TrackedPimRequest[];
}

export interface QuickPimPreferences {
  defaultDurationHours: number;
  defaultExtensionDurationHours: number;
  defaultSort: SortMode;
  defaultSortDirection: SortDirection;
  recentJustificationLimit: number;
  activityHistoryLimit: number;
  darkMode: boolean;
  showAssignedRoles: boolean;
  showRemainingActivationTime: boolean;
  showActivationCounters: boolean;
  showEnablementDetails: boolean;
  showLastEnablementDate: boolean;
  backgroundPreRefreshEnabled: boolean;
  requestNotificationsEnabled: boolean;
  expiryReminderMinutes: number;
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
  refreshStartedAt?: number;
  cacheKey?: string;
  diagnostics?: AccessDiagnostic[];
  truncated?: boolean;
  totalItems?: number;
}

export type TargetActivationCache = Partial<Record<AccessSetupTarget, CachedActivationEntry>>;

export interface QuickPimDataCache {
  version?: 2;
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
  principalName?: string;
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
  tabsAttempted?: number;
  tabsScanned: number;
  failedTabs?: number;
  captured: TokenKind[];
  failureSummary?: string;
}

export interface PortalRecoveryOpenResult {
  requestedCount: number;
  openedCount: number;
  reusedCount: number;
  managedCount: number;
  grouped: boolean;
  journeyCreatedAt?: number;
}

export interface PortalRecoveryStatus {
  state: PortalRecoveryState;
  managedTargets: AccessSetupTarget[];
  interactionTargets: AccessSetupTarget[];
  grouped: boolean;
  interactionReason?: PortalRecoveryInteractionReason;
}

export interface PortalRecoveryFocusResult {
  focused: boolean;
  status: PortalRecoveryStatus;
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
  requestStatus?: TrackedPimRequestStatus;
  error?: string;
  accessRecoveryTarget?: AccessSetupTarget;
  outcomeUnknown?: boolean;
  trackingUnavailable?: boolean;
}

export interface ActivationResponse {
  success: boolean;
  results: ActivationResult[];
  errors: ActivationResult[];
  sourceInstallationId?: string;
  sourceDeviceName?: string;
}

export interface TrackedRequestExtensionResult {
  success: boolean;
  message: string;
  sourceRequestId: string;
  requestId?: string;
  scheduledStartAt?: string;
  scheduledEndAt?: string;
  durationHours?: number;
}

export type RequestOperationAction = "activate" | "deactivate";
export type RequestOperationState = "running" | "complete" | "error" | "uncertain";
export type RequestOperationItemState =
  | "prepared"
  | "sending"
  | "accepted"
  | "tracking"
  | "terminal"
  | "uncertain";

export interface RequestOperationItemRecord {
  itemId: string;
  itemName: string;
  itemType: ActivationItemType;
  tenantId?: string;
  principalId?: string;
  scopeLabel?: string;
  state: RequestOperationItemState;
  updatedAt: number;
  requestId?: string;
  trackedRequestId?: string;
  pendingTrackedRequest?: TrackedPimRequest;
  result?: ActivationResult;
  error?: string;
}

export interface RequestOperationRecord {
  id: string;
  action: RequestOperationAction;
  itemIds: string[];
  targets: AccessSetupTarget[];
  tenantId?: string;
  principalId?: string;
  items?: RequestOperationItemRecord[];
  state: RequestOperationState;
  startedAt: number;
  updatedAt: number;
  terminalAt?: number;
  nextActionAt?: number;
  durationHours?: number;
  justification?: string;
  ticketInfo?: TicketInfo;
  bundleName?: string;
  sourceInstallationId?: string;
  sourceDeviceName?: string;
  revision?: number;
  response?: ActivationResponse;
  error?: string;
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
