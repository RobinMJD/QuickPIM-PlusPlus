import {
  applyActivationRequirements,
  buildDeactivationRequest,
  buildRolePolicyRequirementMap,
  buildActivationRequest,
  getActiveUntilFromScheduleInfo,
  getRoleDefinitionLookupKeys,
  normalizeAzureRole,
  normalizeDirectoryRole,
  normalizePimGroup
} from "./lib/pim";
import { azureManagementUrl, encodePathSegment, graphApiUrl } from "./lib/apiUrls";
import { CLAIMS_CHALLENGE_MESSAGE, isClaimsChallengeMessage } from "./lib/apiErrors";
import { mapWithConcurrency } from "./lib/concurrency";
import {
  getRequiredGraphActivationScopes,
  getGraphTokenOverallScore,
  getGraphTokenTargetScore,
  getGraphTokenTargets,
  hasGraphActivationScope,
  type GraphTokenTarget
} from "./lib/graphTokenCapabilities";
import { isTrustedRuntimeSender, validateQuickPimMessage } from "./lib/messages";
import { isPrivilegedAzureRoleDefinition } from "./lib/privilegedRoles";
import {
  assertAllowedApiUrl,
  getAllowedTokenKindForUrl,
  isAllowedPortalTokenSource,
  sanitizeErrorMessage,
  validateCapturedToken
} from "./lib/security";
import { assertFreshToken, decodeToken, makeTokenStatus } from "./lib/token";
import type {
  ActivationItem,
  ActivationDataResult,
  ActivationSnapshot,
  ActivationResponse,
  ActivationStatus,
  AccessDiagnostic,
  AccessSetupTarget,
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

interface StoredTokens {
  graphToken?: string;
  tokenTimestamp?: number;
  tokenSource?: string;
  graphDirectoryRoleToken?: string;
  graphDirectoryRoleTokenTimestamp?: number;
  graphDirectoryRoleTokenSource?: string;
  graphPimGroupToken?: string;
  graphPimGroupTokenTimestamp?: number;
  graphPimGroupTokenSource?: string;
  azureManagementToken?: string;
  azureManagementTokenTimestamp?: number;
  azureManagementTokenSource?: string;
}

type ActivationRequirements = NonNullable<ActivationItem["activationRequirements"]>;
interface AzureRoleDefinitionResponse {
  properties?: {
    roleName?: string;
    permissions?: Array<{
      actions?: string[];
      dataActions?: string[];
    }>;
  };
}

interface AzureRoleDefinitionInfo {
  displayName: string;
  isPrivileged?: boolean;
}

const REQUEST_HEADER_OPTIONS = ["requestHeaders", "extraHeaders"];
const TOKEN_KINDS: TokenKind[] = ["graph", "azureManagement"];

chrome.webRequest.onSendHeaders.addListener(
  (details) => captureToken(details),
  { urls: ["https://graph.microsoft.com/*", "https://management.azure.com/*"] },
  REQUEST_HEADER_OPTIONS
);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isTrustedRuntimeSender(sender)) {
    sendResponse({ success: false, error: "Untrusted QuickPIM++ message sender." });
    return false;
  }

  let validatedMessage: ReturnType<typeof validateQuickPimMessage>;
  try {
    validatedMessage = validateQuickPimMessage(message);
  } catch (error) {
    sendResponse({ success: false, error: sanitizeErrorMessage(error) });
    return false;
  }

  handleMessage(validatedMessage, sender)
    .then((data) => sendResponse({ success: true, data }))
    .catch((error: unknown) => {
      const message = sanitizeErrorMessage(error);
      sendResponse({ success: false, error: message });
    });
  return true;
});

async function handleMessage(message: ReturnType<typeof validateQuickPimMessage>, sender: chrome.runtime.MessageSender): Promise<unknown> {
  switch (message.action) {
    case "getTokenStatus":
      return getTokenStatus();
    case "clearToken":
      await clearTokens();
      return true;
    case "getActivationItems":
      return getActivationItems(message.targets);
    case "getActiveItems":
      return getActiveItems(message.targets);
    case "getActivationSnapshot":
      return getActivationSnapshot(message.targets);
    case "capturePortalTokens":
      return capturePortalTokens(message.tokens, message.source, sender);
    case "activateItems":
      return activateItems(message.items, message.durationHours, message.justification, message.ticketInfo || {});
    case "deactivateItems":
      return deactivateItems(message.items, message.justification || "", message.ticketInfo || {});
    default:
      throw new Error("Unsupported QuickPIM++ message");
  }
}

function captureToken(details: chrome.webRequest.WebRequestHeadersDetails): void {
  const tokenKind = getAllowedTokenKindForUrl(details.url);
  if (!tokenKind) {
    return;
  }

  const authHeader = details.requestHeaders?.find((header) => header.name.toLowerCase() === "authorization");
  if (!authHeader?.value?.startsWith("Bearer ")) {
    return;
  }

  const token = authHeader.value.slice(7);
  const validation = validateCapturedToken(token, tokenKind);
  if (!validation.ok) {
    return;
  }

  void storeCapturedToken(tokenKind, token, details.url);
}

async function capturePortalTokens(
  tokens: string[],
  source: string | undefined,
  sender: chrome.runtime.MessageSender
): Promise<{ captured: TokenKind[] }> {
  const sourceUrl = sender.url || sender.tab?.url || sender.origin;
  if (!isAllowedPortalTokenSource(sourceUrl)) {
    throw new Error("Portal token capture is only allowed from Microsoft Entra pages.");
  }

  const candidates = new Map<TokenKind, { token: string; score: number }>();
  for (const token of tokens) {
    for (const tokenKind of TOKEN_KINDS) {
      const validation = validateCapturedToken(token, tokenKind);
      if (!validation.ok) {
        continue;
      }
      const score = getTokenCaptureScore(validation.decoded, tokenKind);
      const current = candidates.get(tokenKind);
      if (!current || score > current.score) {
        candidates.set(tokenKind, { token, score });
      }
    }
  }

  const captured: TokenKind[] = [];
  for (const [tokenKind, candidate] of candidates) {
    const stored = await storeCapturedToken(tokenKind, candidate.token, source || sourceUrl || "entra.microsoft.com storage");
    if (stored) {
      captured.push(tokenKind);
    }
  }
  return { captured };
}

async function storeCapturedToken(tokenKind: TokenKind, token: string, source: string, timestamp = Date.now()): Promise<boolean> {
  const validation = validateCapturedToken(token, tokenKind, timestamp);
  if (!validation.ok) {
    return false;
  }

  if (tokenKind === "graph") {
    return storeCapturedGraphToken(token, source, timestamp, validation.decoded);
  }

  const tokens = await getStoredTokens();
  const currentToken = tokens.azureManagementToken;
  if (currentToken) {
    const currentValidation = validateCapturedToken(currentToken, tokenKind, timestamp);
    if (currentValidation.ok && shouldKeepCurrentToken(currentValidation.decoded, validation.decoded, tokenKind)) {
      return false;
    }
  }

  await chrome.storage.local.set({
    azureManagementToken: token,
    azureManagementTokenTimestamp: timestamp,
    azureManagementTokenSource: source
  });
  return true;
}

async function storeCapturedGraphToken(
  token: string,
  source: string,
  timestamp: number,
  decoded: Record<string, unknown>
): Promise<boolean> {
  const tokens = await getStoredTokens();
  const updates: Partial<StoredTokens> = {};

  if (shouldStoreGenericGraphToken(tokens.graphToken, decoded, timestamp)) {
    updates.graphToken = token;
    updates.tokenTimestamp = timestamp;
    updates.tokenSource = source;
  }

  for (const target of getGraphTokenTargets(decoded)) {
    if (shouldStoreTargetGraphToken(tokens, target, decoded, timestamp)) {
      Object.assign(updates, getGraphTokenStorageUpdate(target, token, source, timestamp));
    }
  }

  if (!Object.keys(updates).length) {
    return false;
  }

  await chrome.storage.local.set(updates);
  return true;
}

function shouldStoreGenericGraphToken(currentToken: string | undefined, incoming: Record<string, unknown>, timestamp: number): boolean {
  if (!currentToken) {
    return true;
  }
  const currentValidation = validateCapturedToken(currentToken, "graph", timestamp);
  return !currentValidation.ok || !shouldKeepCurrentToken(currentValidation.decoded, incoming, "graph");
}

function shouldStoreTargetGraphToken(
  tokens: StoredTokens,
  target: GraphTokenTarget,
  incoming: Record<string, unknown>,
  timestamp: number
): boolean {
  const currentToken = getStoredGraphTokenForTarget(tokens, target);
  if (!currentToken) {
    return true;
  }

  const currentValidation = validateCapturedToken(currentToken, "graph", timestamp);
  if (!currentValidation.ok) {
    return true;
  }

  const currentScore = getGraphTokenTargetScore(currentValidation.decoded, target);
  const incomingScore = getGraphTokenTargetScore(incoming, target);
  if (currentScore > incomingScore) {
    return false;
  }
  const currentExpiry = Number(currentValidation.decoded.exp) || 0;
  const incomingExpiry = Number(incoming.exp) || 0;
  return incomingScore > currentScore || incomingExpiry >= currentExpiry;
}

function getGraphTokenStorageUpdate(
  target: GraphTokenTarget,
  token: string,
  source: string,
  timestamp: number
): Partial<StoredTokens> {
  if (target === "directoryRole") {
    return {
      graphDirectoryRoleToken: token,
      graphDirectoryRoleTokenTimestamp: timestamp,
      graphDirectoryRoleTokenSource: source
    };
  }
  return {
    graphPimGroupToken: token,
    graphPimGroupTokenTimestamp: timestamp,
    graphPimGroupTokenSource: source
  };
}

function shouldKeepCurrentToken(current: Record<string, unknown>, incoming: Record<string, unknown>, tokenKind: TokenKind): boolean {
  const currentScore = getTokenCaptureScore(current, tokenKind);
  const incomingScore = getTokenCaptureScore(incoming, tokenKind);
  if (currentScore > incomingScore) {
    return true;
  }
  const currentExpiry = Number(current.exp) || 0;
  const incomingExpiry = Number(incoming.exp) || 0;
  return currentScore === incomingScore && currentExpiry >= incomingExpiry;
}

function getTokenCaptureScore(decoded: Record<string, unknown>, tokenKind: TokenKind): number {
  if (tokenKind === "azureManagement") {
    return 1;
  }
  return getGraphTokenOverallScore(decoded) || 1;
}

async function getStoredTokens(): Promise<StoredTokens> {
  return chrome.storage.local.get([
    "graphToken",
    "tokenTimestamp",
    "tokenSource",
    "graphDirectoryRoleToken",
    "graphDirectoryRoleTokenTimestamp",
    "graphDirectoryRoleTokenSource",
    "graphPimGroupToken",
    "graphPimGroupTokenTimestamp",
    "graphPimGroupTokenSource",
    "azureManagementToken",
    "azureManagementTokenTimestamp",
    "azureManagementTokenSource"
  ]);
}

async function clearTokens(): Promise<void> {
  await chrome.storage.local.remove([
    "graphToken",
    "tokenTimestamp",
    "tokenSource",
    "graphDirectoryRoleToken",
    "graphDirectoryRoleTokenTimestamp",
    "graphDirectoryRoleTokenSource",
    "graphPimGroupToken",
    "graphPimGroupTokenTimestamp",
    "graphPimGroupTokenSource",
    "azureManagementToken",
    "azureManagementTokenTimestamp",
    "azureManagementTokenSource"
  ]);
}

async function clearTokenKind(tokenKind: "graph" | "azureManagement"): Promise<void> {
  if (tokenKind === "graph") {
    await chrome.storage.local.remove([
      "graphToken",
      "tokenTimestamp",
      "tokenSource",
      "graphDirectoryRoleToken",
      "graphDirectoryRoleTokenTimestamp",
      "graphDirectoryRoleTokenSource",
      "graphPimGroupToken",
      "graphPimGroupTokenTimestamp",
      "graphPimGroupTokenSource"
    ]);
    return;
  }

  await chrome.storage.local.remove([
    "azureManagementToken",
    "azureManagementTokenTimestamp",
    "azureManagementTokenSource"
  ]);
}

async function getTokenStatus(): Promise<TokenStatus> {
  const tokens = await getStoredTokens();
  const graphStatusToken = selectGraphTokenForStatus(tokens);
  const graphValidation = graphStatusToken?.token ? validateCapturedToken(graphStatusToken.token, "graph") : undefined;
  const directoryRoleStatusToken = selectGraphTokenForTargetStatus(tokens, "directoryRole");
  const pimGroupStatusToken = selectGraphTokenForTargetStatus(tokens, "pimGroup");
  const directoryRoleValidation = directoryRoleStatusToken?.token ? validateCapturedToken(directoryRoleStatusToken.token, "graph") : undefined;
  const pimGroupValidation = pimGroupStatusToken?.token ? validateCapturedToken(pimGroupStatusToken.token, "graph") : undefined;
  const azureValidation = tokens.azureManagementToken
    ? validateCapturedToken(tokens.azureManagementToken, "azureManagement")
    : undefined;

  if (graphValidation && !graphValidation.ok) {
    await clearTokenKind("graph");
  }
  if (azureValidation && !azureValidation.ok) {
    await clearTokenKind("azureManagement");
  }

  return {
    graph: graphValidation?.ok ? makeTokenStatus(graphStatusToken?.token, graphStatusToken?.timestamp, graphStatusToken?.source) : { hasToken: false },
    graphTargets: {
      directoryRole: directoryRoleValidation?.ok
        ? makeTokenStatus(directoryRoleStatusToken?.token, directoryRoleStatusToken?.timestamp, directoryRoleStatusToken?.source)
        : { hasToken: false },
      pimGroup: pimGroupValidation?.ok
        ? makeTokenStatus(pimGroupStatusToken?.token, pimGroupStatusToken?.timestamp, pimGroupStatusToken?.source)
        : { hasToken: false }
    },
    azureManagement: azureValidation?.ok
      ? makeTokenStatus(
          tokens.azureManagementToken,
          tokens.azureManagementTokenTimestamp,
          tokens.azureManagementTokenSource
        )
      : { hasToken: false }
  };
}

function selectGraphTokenForTargetStatus(tokens: StoredTokens, target: GraphTokenTarget): { token?: string; timestamp?: number; source?: string } | undefined {
  if (target === "directoryRole" && tokens.graphDirectoryRoleToken) {
    return {
      token: tokens.graphDirectoryRoleToken,
      timestamp: tokens.graphDirectoryRoleTokenTimestamp,
      source: tokens.graphDirectoryRoleTokenSource
    };
  }
  if (target === "pimGroup" && tokens.graphPimGroupToken) {
    return {
      token: tokens.graphPimGroupToken,
      timestamp: tokens.graphPimGroupTokenTimestamp,
      source: tokens.graphPimGroupTokenSource
    };
  }
  return { token: tokens.graphToken, timestamp: tokens.tokenTimestamp, source: tokens.tokenSource };
}

function selectGraphTokenForStatus(tokens: StoredTokens): { token?: string; timestamp?: number; source?: string } | undefined {
  const candidates = [
    { token: tokens.graphToken, timestamp: tokens.tokenTimestamp, source: tokens.tokenSource },
    {
      token: tokens.graphDirectoryRoleToken,
      timestamp: tokens.graphDirectoryRoleTokenTimestamp,
      source: tokens.graphDirectoryRoleTokenSource
    },
    {
      token: tokens.graphPimGroupToken,
      timestamp: tokens.graphPimGroupTokenTimestamp,
      source: tokens.graphPimGroupTokenSource
    }
  ];

  return candidates
    .filter((candidate) => Boolean(candidate.token))
    .sort((a, b) => {
      const aDecoded = decodeToken(a.token || "");
      const bDecoded = decodeToken(b.token || "");
      const scoreDelta = (bDecoded ? getTokenCaptureScore(bDecoded, "graph") : 0) - (aDecoded ? getTokenCaptureScore(aDecoded, "graph") : 0);
      if (scoreDelta) {
        return scoreDelta;
      }
      return (b.timestamp || 0) - (a.timestamp || 0);
    })[0];
}

async function getActivationItems(targets: AccessSetupTarget[] = ["directoryRole", "azureRole", "pimGroup"]): Promise<{ items: ActivationItem[]; errors: string[]; diagnostics: AccessDiagnostic[] }> {
  const tokens = await getStoredTokens();
  const fetchers: Record<AccessSetupTarget, () => Promise<{ items: ActivationItem[]; error?: string; diagnostic: AccessDiagnostic }>> = {
    directoryRole: () => fetchItemGroup("directoryRole", "graph", getGraphTokenForTarget(tokens, "directoryRole"), getDirectoryRoles),
    azureRole: () => fetchItemGroup("azureRole", "azureManagement", tokens.azureManagementToken, getAzureRoles),
    pimGroup: () => fetchItemGroup("pimGroup", "graph", getGraphTokenForTarget(tokens, "pimGroup"), getPimGroups)
  };
  const results = await Promise.all(targets.map((target) => fetchers[target]()));

  return {
    items: dedupeItems(results.flatMap((result) => result.items)),
    errors: results.flatMap((result) => result.error ? [result.error] : []),
    diagnostics: results.map((result) => result.diagnostic)
  };
}

async function getActiveItems(targets: AccessSetupTarget[] = ["directoryRole", "azureRole", "pimGroup"]): Promise<{ items: ActivationItem[]; errors: string[]; diagnostics: AccessDiagnostic[] }> {
  const tokens = await getStoredTokens();
  const fetchers: Record<AccessSetupTarget, () => Promise<{ items: ActivationItem[]; error?: string; diagnostic: AccessDiagnostic }>> = {
    directoryRole: () => fetchItemGroup("directoryRole", "graph", getGraphTokenForTarget(tokens, "directoryRole"), getActiveDirectoryRoles),
    azureRole: () => fetchItemGroup("azureRole", "azureManagement", tokens.azureManagementToken, getActiveAzureRoles),
    pimGroup: () => fetchItemGroup("pimGroup", "graph", getGraphTokenForTarget(tokens, "pimGroup"), getActivePimGroups)
  };
  const results = await Promise.all(targets.map((target) => fetchers[target]()));

  return {
    items: dedupeItems(results.flatMap((result) => result.items)),
    errors: results.flatMap((result) => result.error ? [result.error] : []),
    diagnostics: results.map((result) => result.diagnostic)
  };
}

interface TargetSnapshotResult {
  target: AccessSetupTarget;
  eligible: ActivationDataResult;
  active: ActivationDataResult;
}

async function getActivationSnapshot(targets: AccessSetupTarget[] = ["directoryRole", "azureRole", "pimGroup"]): Promise<ActivationSnapshot> {
  const tokens = await getStoredTokens();
  const fetchers: Record<AccessSetupTarget, () => Promise<TargetSnapshotResult>> = {
    directoryRole: () =>
      fetchSnapshotGroup(
        "directoryRole",
        "graph",
        getGraphTokenForTarget(tokens, "directoryRole"),
        getDirectoryRoleSnapshot
      ),
    azureRole: () =>
      fetchSnapshotGroup(
        "azureRole",
        "azureManagement",
        tokens.azureManagementToken,
        getAzureRoleSnapshot
      ),
    pimGroup: () =>
      fetchSnapshotGroup(
        "pimGroup",
        "graph",
        getGraphTokenForTarget(tokens, "pimGroup"),
        getPimGroupSnapshot
      )
  };
  const results = await Promise.all(targets.map((target) => fetchers[target]()));
  return {
    eligible: combineSnapshotResults(results, "eligible"),
    active: combineSnapshotResults(results, "active"),
    eligibleByTarget: Object.fromEntries(results.map((result) => [result.target, result.eligible])),
    activeByTarget: Object.fromEntries(results.map((result) => [result.target, result.active]))
  };
}

async function fetchSnapshotGroup(
  target: AccessSetupTarget,
  tokenKind: TokenKind,
  token: string | undefined,
  fetcher: (token: string) => Promise<[ActivationItem[], ActivationItem[]]>
): Promise<TargetSnapshotResult> {
  if (!token) {
    const error = tokenKind === "graph" ? "Graph token is missing." : "Azure Management token is missing.";
    return {
      target,
      eligible: makeSnapshotData(target, [], error),
      active: makeSnapshotData(target, [], error)
    };
  }

  try {
    const [eligibleItems, activeItems] = await fetcher(token);
    return {
      target,
      eligible: makeSnapshotData(target, eligibleItems),
      active: makeSnapshotData(target, activeItems)
    };
  } catch (error) {
    const sanitized = sanitizeErrorMessage(error);
    return {
      target,
      eligible: makeSnapshotData(target, [], sanitized),
      active: makeSnapshotData(target, [], sanitized)
    };
  }
}

function makeSnapshotData(target: AccessSetupTarget, items: ActivationItem[], error?: string): ActivationDataResult {
  const checkedAt = new Date().toISOString();
  return {
    items,
    errors: error ? [error] : [],
    diagnostics: [{
      target,
      success: !error,
      checkedAt,
      ...(error ? { error } : {})
    }]
  };
}

function combineSnapshotResults(results: TargetSnapshotResult[], bucket: "eligible" | "active"): ActivationDataResult {
  return {
    items: dedupeItems(results.flatMap((result) => result[bucket].items)),
    errors: results.flatMap((result) => result[bucket].errors),
    diagnostics: results.flatMap((result) => result[bucket].diagnostics || [])
  };
}

function getGraphTokenForTarget(tokens: StoredTokens, target: GraphTokenTarget): string | undefined {
  return getStoredGraphTokenForTarget(tokens, target) || tokens.graphToken;
}

function getStoredGraphTokenForTarget(tokens: StoredTokens, target: GraphTokenTarget): string | undefined {
  return target === "directoryRole" ? tokens.graphDirectoryRoleToken : tokens.graphPimGroupToken;
}

async function fetchItemGroup(
  target: AccessSetupTarget,
  tokenKind: TokenKind,
  token: string | undefined,
  fetcher: (token: string) => Promise<ActivationItem[]>
): Promise<{ items: ActivationItem[]; error?: string; diagnostic: AccessDiagnostic }> {
  const checkedAt = new Date().toISOString();
  if (!token) {
    return {
      items: [],
      error: tokenKind === "graph" ? "Graph token is missing." : "Azure Management token is missing.",
      diagnostic: {
        target,
        success: false,
        checkedAt,
        error: tokenKind === "graph" ? "Graph token is missing." : "Azure Management token is missing."
      }
    };
  }

  try {
    const items = await fetcher(token);
    return {
      items,
      diagnostic: {
        target,
        success: true,
        checkedAt
      }
    };
  } catch (error) {
    const sanitized = sanitizeErrorMessage(error);
    return {
      items: [],
      error: sanitized,
      diagnostic: {
        target,
        success: false,
        checkedAt,
        error: sanitized
      }
    };
  }
}

async function getDirectoryRoles(graphToken: string): Promise<ActivationItem[]> {
  assertFreshToken(graphToken, "graph");
  const principalId = await getPrincipalId(graphToken);
  const query = new URLSearchParams({
    "$filter": `principalId eq '${principalId}'`,
    "$expand": "roleDefinition"
  });
  const roles = await fetchAllPages<DirectoryRoleApi>(
    graphApiUrl(`/v1.0/roleManagement/directory/roleEligibilitySchedules?${query.toString()}`),
    graphToken
  );
  const [definitions, scopeNames, policyRequirements] = await Promise.all([
    getDirectoryRoleDefinitionsBestEffort(graphToken),
    getDirectoryScopeNamesBestEffort(graphToken, roles),
    getDirectoryRolePolicyRequirementsBestEffort(graphToken)
  ]);

  return roles.map((role) => {
    const namedRole = withDirectoryRoleScopeName(withDirectoryRoleDefinitionName(role, definitions), scopeNames);
    const item = normalizeDirectoryRole(namedRole);
    return applyActivationRequirements(
      item,
      policyRequirements[item.roleDefinitionId.toLowerCase()] ||
        policyRequirements[(namedRole.roleDefinition?.id || "").toLowerCase()] ||
        policyRequirements[(namedRole.roleDefinition?.templateId || "").toLowerCase()]
    );
  });
}

async function getDirectoryRoleSnapshot(graphToken: string): Promise<[ActivationItem[], ActivationItem[]]> {
  assertFreshToken(graphToken, "graph");
  const principalId = await getPrincipalId(graphToken);
  const eligibleQuery = new URLSearchParams({
    "$filter": `principalId eq '${principalId}'`,
    "$expand": "roleDefinition"
  });
  const [eligibleRoles, assignmentRequests] = await Promise.all([
    fetchAllPages<DirectoryRoleApi>(
      graphApiUrl(`/v1.0/roleManagement/directory/roleEligibilitySchedules?${eligibleQuery.toString()}`),
      graphToken
    ),
    fetchAllPages<DirectoryRoleApi>(
      graphApiUrl("/v1.0/roleManagement/directory/roleAssignmentScheduleRequests/filterByCurrentUser(on='principal')"),
      graphToken
    )
  ]);
  const [definitions, scopeNames, policyRequirements] = await Promise.all([
    getDirectoryRoleDefinitionsBestEffort(graphToken),
    getDirectoryScopeNamesBestEffort(graphToken, [...eligibleRoles, ...assignmentRequests]),
    getDirectoryRolePolicyRequirementsBestEffort(graphToken)
  ]);
  const eligible = eligibleRoles.map((role) => {
    const namedRole = withDirectoryRoleScopeName(withDirectoryRoleDefinitionName(role, definitions), scopeNames);
    const item = normalizeDirectoryRole(namedRole);
    return applyActivationRequirements(
      item,
      policyRequirements[item.roleDefinitionId.toLowerCase()] ||
        policyRequirements[(namedRole.roleDefinition?.id || "").toLowerCase()] ||
        policyRequirements[(namedRole.roleDefinition?.templateId || "").toLowerCase()]
    );
  });
  const active = getDirectoryRoleRequestItems(assignmentRequests, definitions, scopeNames, policyRequirements);
  return [eligible, active];
}

function getDirectoryRoleRequestItems(
  requests: DirectoryRoleApi[],
  definitions: Record<string, DirectoryRoleDefinitionInfo>,
  scopeNames: Record<string, string>,
  policyRequirements: Record<string, Partial<ActivationRequirements>> = {}
): ActivationItem[] {
  const now = Date.now();
  return requests
    .map((role) => {
      const status = getScheduleRequestActivationStatus(role);
      const activeUntil = getActiveUntilFromScheduleInfo(role.scheduleInfo);
      return { role, status, activeUntil };
    })
    .filter((request): request is { role: DirectoryRoleApi; status: Exclude<ActivationStatus, "eligible">; activeUntil: string | undefined } =>
      Boolean(request.status) && (request.status === "pendingApproval" || !request.activeUntil || new Date(request.activeUntil).getTime() > now)
    )
    .map(({ role, status, activeUntil }) => {
      const namedRole = withDirectoryRoleScopeName(withDirectoryRoleDefinitionName(role, definitions), scopeNames);
      const item = normalizeDirectoryRole(namedRole);
      return {
        ...applyActivationRequirements(
          item,
          policyRequirements[item.roleDefinitionId.toLowerCase()] ||
            policyRequirements[(namedRole.roleDefinition?.id || "").toLowerCase()] ||
            policyRequirements[(namedRole.roleDefinition?.templateId || "").toLowerCase()]
        ),
        status,
        ...(status === "active" && activeUntil ? { activeUntil } : {})
      };
    });
}

function getScheduleRequestActivationStatus(request: { action?: string; status?: string }): Exclude<ActivationStatus, "eligible"> | undefined {
  if (!isSelfActivateRequest(request)) {
    return undefined;
  }
  if (isActiveRequestStatus(request.status)) {
    return "active";
  }
  if (isPendingApprovalRequestStatus(request.status)) {
    return "pendingApproval";
  }
  return undefined;
}

function isSelfActivateRequest(request: { action?: string }): boolean {
  return !request.action || request.action.replace(/\s+/g, "").toLowerCase() === "selfactivate";
}

function isActiveRequestStatus(status: string | undefined): boolean {
  const normalized = normalizeRequestStatus(status);
  return normalized === "provisioned" || normalized === "granted";
}

function isPendingApprovalRequestStatus(status: string | undefined): boolean {
  const normalized = normalizeRequestStatus(status);
  return Boolean(normalized) && normalized.includes("pending") && (normalized.includes("approval") || normalized.includes("admin"));
}

function normalizeRequestStatus(status: string | undefined): string {
  return (status || "").replace(/[\s_-]+/g, "").toLowerCase();
}

interface DirectoryRoleDefinitionInfo {
  displayName?: string;
  isPrivileged?: boolean;
}

async function getDirectoryRoleDefinitions(graphToken: string): Promise<Record<string, DirectoryRoleDefinitionInfo>> {
  const roles = await fetchAllPages<DirectoryRoleDefinitionApi>(
    graphApiUrl("/v1.0/roleManagement/directory/roleDefinitions"),
    graphToken
  );
  return buildDirectoryRoleDefinitionInfoMap(roles);
}

async function getDirectoryRoleDefinitionsBestEffort(graphToken: string): Promise<Record<string, DirectoryRoleDefinitionInfo>> {
  try {
    return await getDirectoryRoleDefinitions(graphToken);
  } catch {
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
        graphApiUrl(`/beta/policies/roleManagementPolicyAssignments?${query.toString()}`),
        graphToken
      );
    })
  );

  return buildRolePolicyRequirementMap(
    results.flatMap((result) => (result.status === "fulfilled" ? result.value : []))
  );
}

function buildDirectoryRoleDefinitionInfoMap(roles: DirectoryRoleDefinitionApi[]): Record<string, DirectoryRoleDefinitionInfo> {
  const result: Record<string, DirectoryRoleDefinitionInfo> = {};
  for (const role of roles) {
    const info: DirectoryRoleDefinitionInfo = {
      ...(role.displayName ? { displayName: role.displayName } : {}),
      ...(typeof role.isPrivileged === "boolean" ? { isPrivileged: role.isPrivileged } : {})
    };
    if (role.id) {
      result[role.id] = info;
    }
    if (role.templateId) {
      result[role.templateId] = info;
    }
  }
  return result;
}

function withDirectoryRoleDefinitionName(role: DirectoryRoleApi, definitions: Record<string, DirectoryRoleDefinitionInfo>): DirectoryRoleApi {
  const roleDefinitionId = role.roleDefinitionId || role.roleDefinition?.id || role.roleDefinition?.templateId || role.id || "";
  const definition =
    definitions[roleDefinitionId] ||
    definitions[role.roleDefinition?.id || ""] ||
    definitions[role.roleDefinition?.templateId || ""];
  return {
    ...role,
    roleName:
      role.roleName ||
      role.roleDefinition?.displayName ||
      definition?.displayName,
    isPrivileged: role.isPrivileged ?? role.roleDefinition?.isPrivileged ?? definition?.isPrivileged
  };
}

async function getDirectoryScopeNamesBestEffort(
  graphToken: string,
  roles: Array<Pick<DirectoryRoleApi, "directoryScopeId">>
): Promise<Record<string, string>> {
  const scopeIds = [
    ...new Set(
      roles
        .map((role) => role.directoryScopeId || "/")
        .filter((scopeId) => scopeId && scopeId !== "/")
    )
  ];
  if (!scopeIds.length) {
    return {};
  }

  const entries = await mapWithConcurrency(scopeIds, 6, async (scopeId) => {
    const displayName = await fetchDirectoryScopeDisplayName(graphToken, scopeId);
    return displayName ? ([scopeId, displayName] as const) : undefined;
  });
  return Object.fromEntries(entries.filter((entry): entry is readonly [string, string] => Boolean(entry)));
}

async function fetchDirectoryScopeDisplayName(graphToken: string, directoryScopeId: string): Promise<string | undefined> {
  const objectId = extractDirectoryScopeObjectId(directoryScopeId);
  if (!objectId) {
    return undefined;
  }

  for (const url of getDirectoryScopeLookupUrls(directoryScopeId, objectId)) {
    try {
      const data = await fetchJson<{ displayName?: string; userPrincipalName?: string }>(url, graphToken);
      const displayName = data.displayName || data.userPrincipalName;
      if (displayName) {
        return displayName;
      }
    } catch {
      // Keep trying narrower fallback endpoints because scope IDs can be typed or raw object paths.
    }
  }
  return undefined;
}

function getDirectoryScopeLookupUrls(directoryScopeId: string, objectId: string): string[] {
  const normalized = directoryScopeId.toLowerCase();
  const encodedId = encodePathSegment(objectId);

  if (normalized.startsWith("/administrativeunits/")) {
    return [graphApiUrl(`/v1.0/directory/administrativeUnits/${encodedId}?$select=id,displayName`)];
  }

  if (normalized.startsWith("/devices/")) {
    return [graphApiUrl(`/v1.0/devices/${encodedId}?$select=id,displayName`)];
  }

  if (normalized.startsWith("/groups/")) {
    return [graphApiUrl(`/v1.0/groups/${encodedId}?$select=id,displayName`)];
  }

  if (normalized.startsWith("/users/")) {
    return [graphApiUrl(`/v1.0/users/${encodedId}?$select=id,displayName,userPrincipalName`)];
  }

  return [
    graphApiUrl(`/v1.0/directoryObjects/${encodedId}?$select=id,displayName`),
    graphApiUrl(`/v1.0/directory/administrativeUnits/${encodedId}?$select=id,displayName`),
    graphApiUrl(`/v1.0/devices/${encodedId}?$select=id,displayName`),
    graphApiUrl(`/v1.0/groups/${encodedId}?$select=id,displayName`),
    graphApiUrl(`/v1.0/users/${encodedId}?$select=id,displayName,userPrincipalName`)
  ];
}

function extractDirectoryScopeObjectId(directoryScopeId: string): string | undefined {
  const parts = directoryScopeId.split("/").filter(Boolean);
  return parts.at(-1);
}

function withDirectoryRoleScopeName(role: DirectoryRoleApi, scopeNames: Record<string, string>): DirectoryRoleApi {
  const directoryScopeId = role.directoryScopeId || "/";
  const scopeName = role.directoryScope?.displayName || scopeNames[directoryScopeId];
  return scopeName ? { ...role, directoryScopeDisplayName: scopeName } : role;
}

async function getPimGroups(graphToken: string): Promise<ActivationItem[]> {
  assertFreshToken(graphToken, "graph");
  const schedules = await fetchAllPages<PimGroupApi>(
    graphApiUrl("/v1.0/identityGovernance/privilegedAccess/group/eligibilitySchedules/filterByCurrentUser(on='principal')"),
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

async function getPimGroupSnapshot(graphToken: string): Promise<[ActivationItem[], ActivationItem[]]> {
  assertFreshToken(graphToken, "graph");
  const [eligibleSchedules, activeSchedules, assignmentRequests] = await Promise.all([
    fetchAllPages<PimGroupApi>(
      graphApiUrl("/v1.0/identityGovernance/privilegedAccess/group/eligibilitySchedules/filterByCurrentUser(on='principal')"),
      graphToken
    ),
    fetchAllPages<PimGroupApi>(
      graphApiUrl("/v1.0/identityGovernance/privilegedAccess/group/assignmentSchedules/filterByCurrentUser(on='principal')"),
      graphToken
    ),
    fetchAllPages<PimGroupApi>(
      graphApiUrl("/v1.0/identityGovernance/privilegedAccess/group/assignmentScheduleRequests/filterByCurrentUser(on='principal')"),
      graphToken
    )
  ]);
  const groupIds = [
    ...new Set(
      [...eligibleSchedules, ...activeSchedules, ...assignmentRequests]
        .map((schedule) => schedule.groupId)
        .filter(Boolean) as string[]
    )
  ];
  const [groupInfos, policyRequirements] = await Promise.all([
    getGroupInfos(graphToken, groupIds),
    getPimGroupPolicyRequirementsBestEffort(
      graphToken,
      groupIds
    )
  ]);
  const eligible = eligibleSchedules.map((schedule) => {
    const item = normalizePimGroup(schedule, groupInfos[schedule.groupId || ""]);
    const groupPolicy = policyRequirements[item.groupId];
    return applyActivationRequirements(item, groupPolicy?.[item.accessId] || groupPolicy?.default);
  });
  const now = Date.now();
  const active = activeSchedules
    .map((schedule) => {
      const activeUntil = schedule.endDateTime || getActiveUntilFromScheduleInfo(schedule.scheduleInfo);
      return { schedule, activeUntil };
    })
    .filter(({ activeUntil }) => !activeUntil || new Date(activeUntil).getTime() > now)
    .map(({ schedule, activeUntil }) => ({
      ...normalizePimGroup(schedule, groupInfos[schedule.groupId || ""]),
      status: "active" as const,
      ...(activeUntil ? { activeUntil: new Date(activeUntil).toISOString() } : {})
    }));
  const pending = getPimGroupPendingRequestItems(assignmentRequests, groupInfos, policyRequirements);
  return [eligible, [...pending, ...active]];
}

function getPimGroupPendingRequestItems(
  requests: PimGroupApi[],
  groupInfos: Record<string, GroupInfo>,
  policyRequirements: Record<string, Record<string, Partial<ActivationRequirements>>>
): ActivationItem[] {
  return requests
    .filter((request) => getScheduleRequestActivationStatus(request) === "pendingApproval")
    .map((request) => {
      const item = normalizePimGroup(request, groupInfos[request.groupId || ""]);
      const groupPolicy = policyRequirements[item.groupId];
      return {
        ...applyActivationRequirements(item, groupPolicy?.[item.accessId] || groupPolicy?.default),
        status: "pendingApproval" as const
      };
    });
}

async function getPimGroupPolicyRequirementsBestEffort(
  graphToken: string,
  groupIds: string[]
): Promise<Record<string, Record<string, Partial<ActivationRequirements>>>> {
  const entries = await mapWithConcurrency(
    groupIds,
    4,
    async (groupId) => {
      try {
        const query = new URLSearchParams({
          "$filter": `scopeId eq '${groupId}' and scopeType eq 'Group'`,
          "$expand": "policy($expand=rules)"
        });
        const assignments = await fetchAllPages<RoleManagementPolicyAssignmentApi>(
          graphApiUrl(`/beta/policies/roleManagementPolicyAssignments?${query.toString()}`),
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
    }
  );
  return Object.fromEntries(entries);
}

async function getGroupInfos(graphToken: string, groupIds: string[]): Promise<Record<string, GroupInfo>> {
  const entries = await mapWithConcurrency(
    groupIds,
    6,
    async (groupId) => {
      try {
        const group = await fetchJson<GroupInfo>(
          graphApiUrl(`/v1.0/groups/${encodePathSegment(groupId)}?$select=id,displayName,description,mail`),
          graphToken
        );
        return [groupId, group] as const;
      } catch {
        return [groupId, { id: groupId, displayName: groupId }] as const;
      }
    }
  );
  return Object.fromEntries(entries);
}

async function getAzureRoles(azureManagementToken: string): Promise<ActivationItem[]> {
  assertFreshToken(azureManagementToken, "azureManagement");
  const subscriptions = await getSubscriptions(azureManagementToken);
  return getAzureRolesForSubscriptions(azureManagementToken, subscriptions);
}

async function getAzureRoleSnapshot(azureManagementToken: string): Promise<[ActivationItem[], ActivationItem[]]> {
  assertFreshToken(azureManagementToken, "azureManagement");
  const subscriptions = await getSubscriptions(azureManagementToken);
  return Promise.all([
    getAzureRolesForSubscriptions(azureManagementToken, subscriptions),
    getActiveAzureRolesForSubscriptions(azureManagementToken, subscriptions)
  ]);
}

async function getAzureRolesForSubscriptions(
  azureManagementToken: string,
  subscriptions: Array<{ subscriptionId: string; displayName: string }>
): Promise<ActivationItem[]> {
  const roleGroups = await Promise.allSettled(
    subscriptions.map(async (subscription) => {
      const roles = await fetchAllPages<AzureRoleApi>(
        azureManagementUrl(
          `/subscriptions/${encodePathSegment(subscription.subscriptionId)}/providers/Microsoft.Authorization/roleEligibilityScheduleInstances?api-version=2020-10-01&$filter=asTarget()`
        ),
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
  return applyAzureRoleDefinitionMetadata(itemsWithPolicies, azureManagementToken);
}

async function applyAzureRolePolicyRequirements(items: ActivationItem[], token: string): Promise<ActivationItem[]> {
  const azureItems = items.filter((item): item is Extract<ActivationItem, { type: "azureRole" }> => item.type === "azureRole");
  const uniqueScopes = [...new Set(azureItems.map((item) => item.scope))];
  const policyEntries = await mapWithConcurrency(
    uniqueScopes,
    4,
    async (scope) => {
      try {
        const assignments = await fetchAllPages<RoleManagementPolicyAssignmentApi>(
          azureManagementUrl(`${scope}/providers/Microsoft.Authorization/roleManagementPolicyAssignments?api-version=2020-10-01`),
          token
        );
        return [scope, buildRolePolicyRequirementMap(assignments)] as const;
      } catch {
        return [scope, {}] as const;
      }
    }
  );
  const requirementsByScope = Object.fromEntries(policyEntries);

  return items.map((item) => {
    if (item.type !== "azureRole") {
      return item;
    }

    const scopeRequirements = requirementsByScope[item.scope] || {};
    const requirements = getRoleDefinitionLookupKeys(item.roleDefinitionId)
      .map((key) => scopeRequirements[key])
      .find(Boolean);
    return applyActivationRequirements(item, requirements);
  });
}

async function getSubscriptions(token: string): Promise<Array<{ subscriptionId: string; displayName: string }>> {
  const data = await fetchJson<{ value?: Array<{ subscriptionId: string; displayName: string }> }>(
    azureManagementUrl("/subscriptions?api-version=2020-01-01"),
    token
  );
  return data.value || [];
}

async function getActiveDirectoryRoles(graphToken: string): Promise<ActivationItem[]> {
  assertFreshToken(graphToken, "graph");
  const roles = await fetchAllPages<DirectoryRoleApi>(
    graphApiUrl("/v1.0/roleManagement/directory/roleAssignmentScheduleRequests/filterByCurrentUser(on='principal')"),
    graphToken
  );
  const [definitions, scopeNames] = await Promise.all([
    getDirectoryRoleDefinitionsBestEffort(graphToken),
    getDirectoryScopeNamesBestEffort(graphToken, roles)
  ]);
  return getDirectoryRoleRequestItems(roles, definitions, scopeNames);
}

async function getActiveAzureRoles(azureManagementToken: string): Promise<ActivationItem[]> {
  assertFreshToken(azureManagementToken, "azureManagement");
  const subscriptions = await getSubscriptions(azureManagementToken);
  return getActiveAzureRolesForSubscriptions(azureManagementToken, subscriptions);
}

async function getActiveAzureRolesForSubscriptions(
  azureManagementToken: string,
  subscriptions: Array<{ subscriptionId: string; displayName: string }>
): Promise<ActivationItem[]> {
  const now = Date.now();
  const roleGroups = await Promise.allSettled(
    subscriptions.map(async (subscription) => {
      const roles = await fetchAllPages<AzureRoleApi>(
        azureManagementUrl(
          `/subscriptions/${encodePathSegment(subscription.subscriptionId)}/providers/Microsoft.Authorization/roleAssignmentScheduleInstances?api-version=2020-10-01&$filter=asTarget()`
        ),
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
          status: "active" as const,
          ...(role.properties?.endDateTime ? { activeUntil: new Date(role.properties.endDateTime).toISOString() } : {})
        }));
    })
  );

  return applyAzureRoleDefinitionMetadata(
    roleGroups.flatMap((group) => (group.status === "fulfilled" ? group.value : [])),
    azureManagementToken
  );
}

async function applyAzureRoleDefinitionMetadata(items: ActivationItem[], token: string): Promise<ActivationItem[]> {
  const azureItems = items.filter((item): item is Extract<ActivationItem, { type: "azureRole" }> => item.type === "azureRole");
  const definitionIds = [...new Set(azureItems.map((item) => item.roleDefinitionId))];

  if (!definitionIds.length) {
    return items;
  }

  const definitions: Record<string, AzureRoleDefinitionInfo> = Object.fromEntries(
    await mapWithConcurrency(
      definitionIds,
      6,
      async (roleDefinitionId) => {
        try {
          const definition = await fetchJson<AzureRoleDefinitionResponse>(
            azureManagementUrl(`${roleDefinitionId}?api-version=2022-04-01`),
            token
          );
          return [
            roleDefinitionId,
            {
              displayName: definition.properties?.roleName || roleDefinitionId.split("/").at(-1) || roleDefinitionId,
              isPrivileged: isPrivilegedAzureRoleDefinition(definition)
            }
          ] as const;
        } catch {
          return [
            roleDefinitionId,
            {
              displayName: roleDefinitionId.split("/").at(-1) || roleDefinitionId
            }
          ] as const;
        }
      }
    )
  );

  return items.map((item) => {
    if (item.type !== "azureRole") {
      return item;
    }
    const definition = definitions[item.roleDefinitionId];
    if (!definition) {
      return item;
    }
    const displayName = item.displayName === item.roleDefinitionId.split("/").at(-1) ? definition.displayName : item.displayName;
    return {
      ...item,
      ...(displayName ? { sourceName: displayName, displayName } : {}),
      ...(typeof definition.isPrivileged === "boolean" ? { isPrivileged: definition.isPrivileged } : {})
    };
  });
}

async function getActivePimGroups(graphToken: string): Promise<ActivationItem[]> {
  assertFreshToken(graphToken, "graph");
  const [schedules, assignmentRequests] = await Promise.all([
    fetchAllPages<PimGroupApi>(
      graphApiUrl("/v1.0/identityGovernance/privilegedAccess/group/assignmentSchedules/filterByCurrentUser(on='principal')"),
      graphToken
    ),
    fetchAllPages<PimGroupApi>(
      graphApiUrl("/v1.0/identityGovernance/privilegedAccess/group/assignmentScheduleRequests/filterByCurrentUser(on='principal')"),
      graphToken
    )
  ]);
  const groupIds = [
    ...new Set(
      [...schedules, ...assignmentRequests]
        .map((schedule) => schedule.groupId)
        .filter(Boolean) as string[]
    )
  ];
  const [groupInfos, policyRequirements] = await Promise.all([
    getGroupInfos(graphToken, groupIds),
    getPimGroupPolicyRequirementsBestEffort(graphToken, groupIds)
  ]);
  const now = Date.now();
  const active = schedules
    .map((schedule) => {
      const activeUntil = schedule.endDateTime || getActiveUntilFromScheduleInfo(schedule.scheduleInfo);
      return { schedule, activeUntil };
    })
    .filter(({ activeUntil }) => !activeUntil || new Date(activeUntil).getTime() > now)
    .map(({ schedule, activeUntil }) => ({
      ...normalizePimGroup(schedule, groupInfos[schedule.groupId || ""]),
      status: "active" as const,
      ...(activeUntil ? { activeUntil: new Date(activeUntil).toISOString() } : {})
    }));
  return [...getPimGroupPendingRequestItems(assignmentRequests, groupInfos, policyRequirements), ...active];
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
        assertAllowedApiUrl(request.endpoint, request.tokenKind);
        const token = getTokenForActivation(tokens, item, request.tokenKind);
        if (!token) {
          throw new Error(request.tokenKind === "graph" ? "Graph token is missing." : "Azure Management token is missing.");
        }
        assertTokenCanActivate(item, token, request.tokenKind);

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
          throw new Error(sanitizeErrorMessage(getApiErrorMessage(errorData, response) || `${response.status} ${response.statusText}`));
        }

        const data = await safeJson(response);
        return {
          itemId: item.id,
          itemName: item.displayName,
          success: true,
          requestId: getResponseIdentifier(data)
        };
      } catch (error) {
        return {
          itemId: item.id,
          itemName: item.displayName,
          success: false,
          error: sanitizeErrorMessage(error)
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

async function deactivateItems(
  items: ActivationItem[],
  justification: string,
  ticketInfo: TicketInfo
): Promise<ActivationResponse> {
  if (!items.length) {
    throw new Error("Select at least one active item to deactivate.");
  }

  const tokens = await getStoredTokens();
  const startDateTime = new Date().toISOString();
  const results = await Promise.all(
    items.map(async (item) => {
      try {
        const request = buildDeactivationRequest(item, justification.trim(), ticketInfo, startDateTime);
        assertAllowedApiUrl(request.endpoint, request.tokenKind);
        const token = getTokenForActivation(tokens, item, request.tokenKind);
        if (!token) {
          throw new Error(request.tokenKind === "graph" ? "Graph token is missing." : "Azure Management token is missing.");
        }
        assertTokenCanActivate(item, token, request.tokenKind, "deactivation");

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
          throw new Error(sanitizeErrorMessage(getApiErrorMessage(errorData, response) || `${response.status} ${response.statusText}`));
        }

        const data = await safeJson(response);
        return {
          itemId: item.id,
          itemName: item.displayName,
          success: true,
          requestId: getResponseIdentifier(data)
        };
      } catch (error) {
        return {
          itemId: item.id,
          itemName: item.displayName,
          success: false,
          error: sanitizeErrorMessage(error)
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

function assertTokenCanActivate(item: ActivationItem, token: string, tokenKind: TokenKind, operation = "activation"): void {
  if (tokenKind !== "graph" || item.type === "azureRole") {
    return;
  }

  const target: GraphTokenTarget = item.type === "pimGroup" ? "pimGroup" : "directoryRole";
  const decoded = decodeToken(token);
  if (!decoded || hasGraphActivationScope(decoded, target)) {
    return;
  }

  const label = target === "pimGroup" ? "PIM group" : "Entra role";
  const requiredScopes = getRequiredGraphActivationScopes(target).join(" or ");
  throw new Error(`${label} ${operation} needs a captured Graph token with ${requiredScopes}. Run Access Setup and reload the matching Microsoft portal page.`);
}

function getTokenForActivation(tokens: StoredTokens, item: ActivationItem, tokenKind: TokenKind): string | undefined {
  if (tokenKind === "azureManagement") {
    return tokens.azureManagementToken;
  }
  if (item.type === "pimGroup") {
    return getGraphTokenForTarget(tokens, "pimGroup");
  }
  return getGraphTokenForTarget(tokens, "directoryRole");
}

async function fetchAllPages<T>(url: string, token: string): Promise<T[]> {
  const values: T[] = [];
  let nextUrl: string | undefined = url;

  while (nextUrl) {
    assertAllowedApiUrl(nextUrl);
    const data: { value?: T[]; "@odata.nextLink"?: string; nextLink?: string } = await fetchJson(nextUrl, token);
    values.push(...(data.value || []));
    nextUrl = data["@odata.nextLink"] || data.nextLink;
  }

  return values;
}

async function fetchJson<T>(url: string, token: string): Promise<T> {
  assertAllowedApiUrl(url);
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    }
  });

  if (!response.ok) {
    const errorData = await safeJson(response);
    throw new Error(sanitizeErrorMessage(getApiErrorMessage(errorData, response) || `${response.status} ${response.statusText}`));
  }

  return (await response.json()) as T;
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function dedupeItems(items: ActivationItem[]): ActivationItem[] {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

function getApiErrorMessage(payload: unknown, response?: Response): string | undefined {
  const authenticateHeader = response?.headers.get("www-authenticate") || response?.headers.get("WWW-Authenticate");
  if (authenticateHeader && isClaimsChallengeMessage(authenticateHeader)) {
    return CLAIMS_CHALLENGE_MESSAGE;
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const error = (payload as Record<string, unknown>).error;
  if (!error || typeof error !== "object" || Array.isArray(error)) {
    return undefined;
  }
  const message = (error as Record<string, unknown>).message;
  if (typeof message !== "string") {
    return undefined;
  }
  return isClaimsChallengeMessage(message) ? CLAIMS_CHALLENGE_MESSAGE : message;
}

function getResponseIdentifier(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  return typeof record.id === "string" ? record.id : typeof record.name === "string" ? record.name : undefined;
}

async function getPrincipalId(token: string): Promise<string> {
  const tokenPrincipalId = getTokenPrincipalId(token);
  if (tokenPrincipalId) {
    return tokenPrincipalId;
  }

  const me = await fetchJson<{ id?: string }>(graphApiUrl("/v1.0/me?$select=id"), token);
  if (typeof me.id === "string" && me.id.trim()) {
    return me.id;
  }

  throw new Error("Could not determine the signed-in principal from the captured token.");
}

function getTokenPrincipalId(token: string): string | undefined {
  const decoded = decodeToken(token);
  const principalId = decoded?.oid;
  return typeof principalId === "string" && principalId.trim() ? principalId : undefined;
}
