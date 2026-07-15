import { hasRequiredPortalToken } from "./access";
import { ENTRA_PORTAL_URLS } from "./popupModel";
import type {
  AccessSetupTarget,
  PortalRecoveryFocusResult,
  PortalRecoveryOpenResult,
  PortalRecoveryStatus,
  TokenStatus,
  TokenStatusEntry
} from "./types";

export const PORTAL_RECOVERY_SESSION_KEY = "quickPimPortalRecovery.v1";
export const PORTAL_RECOVERY_GROUP_TITLE = "QuickPIM++ access refresh";
export const PORTAL_RECOVERY_SESSION_TTL_MS = 10 * 60_000;
export const PORTAL_RECOVERY_INTERACTION_TIMEOUT_MS = 15_000;
export const PORTAL_RECOVERY_CLEANUP_ALARM_NAME = "quickPimPortalRecoveryCleanup";

interface PortalRecoverySession {
  version: 1;
  createdAt: number;
  groupId?: number;
  windowId?: number;
  tabsByTarget: Partial<Record<AccessSetupTarget, number>>;
  baselineTokenSignatures: Partial<Record<AccessSetupTarget, string>>;
}

export interface PortalRecoveryTabsLike {
  create(properties: chrome.tabs.CreateProperties): Promise<chrome.tabs.Tab>;
  get(tabId: number): Promise<chrome.tabs.Tab>;
  group(options: chrome.tabs.GroupOptions): Promise<number>;
  remove(tabIds: number | number[]): Promise<void>;
  update?(tabId: number, updateProperties: chrome.tabs.UpdateProperties): Promise<chrome.tabs.Tab | undefined>;
}

export interface PortalRecoveryTabGroupsLike {
  update(groupId: number, updateProperties: chrome.tabGroups.UpdateProperties): Promise<chrome.tabGroups.TabGroup | undefined>;
}

export interface PortalRecoveryStorageLike {
  get(key: string): Promise<Record<string, unknown>>;
  set(value: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface PortalRecoveryApis {
  tabs: PortalRecoveryTabsLike;
  tabGroups?: PortalRecoveryTabGroupsLike;
  storage: PortalRecoveryStorageLike;
  windows?: {
    update(windowId: number, updateInfo: chrome.windows.UpdateInfo): Promise<chrome.windows.Window>;
  };
}

let portalRecoveryMutationQueue: Promise<void> = Promise.resolve();

export async function openPortalRecoveryTabs(
  requestedTargets: AccessSetupTarget[],
  tokenStatus: TokenStatus,
  apis: PortalRecoveryApis,
  now = Date.now()
): Promise<PortalRecoveryOpenResult> {
  return enqueuePortalRecoveryMutation(async () => {
    const targets = uniqueTargets(requestedTargets);
    let session = await loadPortalRecoverySession(apis.storage);
    if (session && now - session.createdAt > PORTAL_RECOVERY_SESSION_TTL_MS) {
      await closeTrackedTabs(session, apis.tabs);
      await apis.storage.remove(PORTAL_RECOVERY_SESSION_KEY);
      session = undefined;
    }

    session = session ? await pruneMissingOrNavigatedTabs(session, apis.tabs) : newPortalRecoverySession(now);
    const reusedTargets = targets.filter((target) => session?.tabsByTarget[target] !== undefined);
    const missingTargets = targets.filter((target) => session?.tabsByTarget[target] === undefined);
    const openedTargets: AccessSetupTarget[] = [];

    for (const target of missingTargets) {
      try {
        const tab = await apis.tabs.create({
          url: ENTRA_PORTAL_URLS[target],
          active: false,
          ...(session.windowId !== undefined ? { windowId: session.windowId } : {})
        });
        if (typeof tab.id !== "number") {
          continue;
        }
        session.tabsByTarget[target] = tab.id;
        session.baselineTokenSignatures[target] = getTargetTokenSignature(tokenStatus, target);
        session.windowId ??= tab.windowId;
        openedTargets.push(target);
      } catch {
        // One unavailable target must not prevent the remaining recovery tabs from opening.
      }
    }

    const tabIds = Object.values(session.tabsByTarget).filter((tabId): tabId is number => typeof tabId === "number");
    if (!tabIds.length) {
      await apis.storage.remove(PORTAL_RECOVERY_SESSION_KEY);
      return {
        requestedCount: targets.length,
        openedCount: 0,
        reusedCount: 0,
        managedCount: 0,
        grouped: false
      };
    }

    session.createdAt = now;
    session.groupId = await ensurePortalRecoveryGroup(session, openedTargets, apis);
    await apis.storage.set({ [PORTAL_RECOVERY_SESSION_KEY]: session });
    return {
      requestedCount: targets.length,
      openedCount: openedTargets.length,
      reusedCount: reusedTargets.length,
      managedCount: targets.filter((target) => session.tabsByTarget[target] !== undefined).length,
      grouped: session.groupId !== undefined
    };
  });
}

export async function getPortalRecoveryStatus(
  apis: PortalRecoveryApis,
  now = Date.now()
): Promise<PortalRecoveryStatus> {
  return enqueuePortalRecoveryMutation(async () => {
    let session = await loadPortalRecoverySession(apis.storage);
    if (!session) {
      return idlePortalRecoveryStatus();
    }
    session = await pruneMissingOrNavigatedTabs(session, apis.tabs);
    await saveOrRemoveSession(session, apis.storage);
    return buildPortalRecoveryStatus(session, apis.tabs, now);
  });
}

export async function focusPortalRecoveryTabs(
  apis: PortalRecoveryApis,
  now = Date.now()
): Promise<PortalRecoveryFocusResult> {
  return enqueuePortalRecoveryMutation(async () => {
    let session = await loadPortalRecoverySession(apis.storage);
    if (!session) {
      return { focused: false, status: idlePortalRecoveryStatus() };
    }
    session = await pruneMissingOrNavigatedTabs(session, apis.tabs);
    await saveOrRemoveSession(session, apis.storage);
    const status = await buildPortalRecoveryStatus(session, apis.tabs, now);
    const preferredTargets = status.interactionTargets.length ? status.interactionTargets : status.managedTargets;
    const tabId = preferredTargets.map((target) => session?.tabsByTarget[target]).find((value): value is number => typeof value === "number");
    if (tabId === undefined || !apis.tabs.update) {
      return { focused: false, status };
    }

    try {
      if (session.groupId !== undefined && apis.tabGroups) {
        await apis.tabGroups.update(session.groupId, { collapsed: false });
      }
      await apis.tabs.update(tabId, { active: true });
      if (session.windowId !== undefined && apis.windows) {
        await apis.windows.update(session.windowId, { focused: true });
      }
      return { focused: true, status };
    } catch {
      return { focused: false, status };
    }
  });
}

export function sanitizePortalRecoveryStatus(value: unknown): PortalRecoveryStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return idlePortalRecoveryStatus();
  }
  const record = value as Record<string, unknown>;
  if (record.state !== "idle" && record.state !== "waiting" && record.state !== "interactionRequired") {
    return idlePortalRecoveryStatus();
  }
  const managedTargets = sanitizeTargetArray(record.managedTargets);
  const interactionTargets = sanitizeTargetArray(record.interactionTargets).filter((target) => managedTargets.includes(target));
  if (record.state === "idle" || !managedTargets.length) {
    return idlePortalRecoveryStatus();
  }
  const interactionReason = record.interactionReason === "signIn" || record.interactionReason === "microsoftPrompt"
    ? record.interactionReason
    : undefined;
  return {
    state: record.state,
    managedTargets,
    interactionTargets,
    grouped: record.grouped === true,
    ...(record.state === "interactionRequired" && interactionReason ? { interactionReason } : {})
  };
}

export async function openPortalRecoveryTabsAndReconcile(
  requestedTargets: AccessSetupTarget[],
  loadTokenStatus: () => Promise<TokenStatus>,
  apis: PortalRecoveryApis,
  now = Date.now()
): Promise<PortalRecoveryOpenResult> {
  const baselineTokenStatus = await loadTokenStatus();
  const result = await openPortalRecoveryTabs(requestedTargets, baselineTokenStatus, apis, now);
  await closeCompletedPortalRecoveryTabs(await loadTokenStatus(), apis);
  return result;
}

export async function closeCompletedPortalRecoveryTabs(
  tokenStatus: TokenStatus,
  apis: PortalRecoveryApis
): Promise<AccessSetupTarget[]> {
  return enqueuePortalRecoveryMutation(async () => {
    let session = await loadPortalRecoverySession(apis.storage);
    if (!session) {
      return [];
    }

    session = await pruneMissingOrNavigatedTabs(session, apis.tabs);
    const completedTargets = uniqueTargets(
      Object.keys(session.tabsByTarget).filter((target): target is AccessSetupTarget =>
        isAccessSetupTarget(target) && isTargetRecoveryComplete(session, target, tokenStatus)
      )
    );

    const closedTargets = await closeSessionTargets(session, completedTargets, apis.tabs);
    await saveOrRemoveSession(session, apis.storage);
    return closedTargets;
  });
}

export async function closePortalRecoveryTabsForTargets(
  requestedTargets: AccessSetupTarget[],
  apis: PortalRecoveryApis
): Promise<AccessSetupTarget[]> {
  return enqueuePortalRecoveryMutation(async () => {
    let session = await loadPortalRecoverySession(apis.storage);
    if (!session) {
      return [];
    }
    session = await pruneMissingOrNavigatedTabs(session, apis.tabs);
    const targets = uniqueTargets(requestedTargets).filter((target) => session?.tabsByTarget[target] !== undefined);
    const closedTargets = await closeSessionTargets(session, targets, apis.tabs);
    await saveOrRemoveSession(session, apis.storage);
    return closedTargets;
  });
}

export async function closeExpiredPortalRecoveryTabs(
  apis: PortalRecoveryApis,
  now = Date.now()
): Promise<AccessSetupTarget[]> {
  return enqueuePortalRecoveryMutation(async () => {
    let session = await loadPortalRecoverySession(apis.storage);
    if (!session || now - session.createdAt < PORTAL_RECOVERY_SESSION_TTL_MS) {
      return [];
    }
    session = await pruneMissingOrNavigatedTabs(session, apis.tabs);
    const targets = uniqueTargets(Object.keys(session.tabsByTarget).filter(isAccessSetupTarget));
    const closedTargets = await closeSessionTargets(session, targets, apis.tabs);
    await saveOrRemoveSession(session, apis.storage);
    return closedTargets;
  });
}

function newPortalRecoverySession(now: number): PortalRecoverySession {
  return {
    version: 1,
    createdAt: now,
    tabsByTarget: {},
    baselineTokenSignatures: {}
  };
}

async function ensurePortalRecoveryGroup(
  session: PortalRecoverySession,
  openedTargets: AccessSetupTarget[],
  apis: PortalRecoveryApis
): Promise<number | undefined> {
  const openedTabIds = openedTargets
    .map((target) => session.tabsByTarget[target])
    .filter((tabId): tabId is number => typeof tabId === "number");
  let groupId = session.groupId;

  if (groupId !== undefined && openedTabIds.length) {
    try {
      await apis.tabs.group({ groupId, tabIds: openedTabIds });
    } catch {
      groupId = undefined;
    }
  }

  if (groupId === undefined) {
    const allTabIds = Object.values(session.tabsByTarget).filter((tabId): tabId is number => typeof tabId === "number");
    try {
      groupId = await apis.tabs.group({
        tabIds: allTabIds,
        ...(session.windowId !== undefined ? { createProperties: { windowId: session.windowId } } : {})
      });
    } catch {
      return undefined;
    }
  }

  if (apis.tabGroups) {
    try {
      await apis.tabGroups.update(groupId, {
        title: PORTAL_RECOVERY_GROUP_TITLE,
        color: "blue",
        collapsed: true
      });
    } catch {
      // Grouping still provides value when its visual metadata cannot be updated.
    }
  }
  return groupId;
}

async function pruneMissingOrNavigatedTabs(
  session: PortalRecoverySession,
  tabs: PortalRecoveryTabsLike
): Promise<PortalRecoverySession> {
  const entries = Object.entries(session.tabsByTarget) as Array<[AccessSetupTarget, number]>;
  const survivingTabs = (await Promise.all(entries.map(async ([target, tabId]) => {
    try {
      const tab = await tabs.get(tabId);
      if (!isManagedPortalRecoveryTab(tab, target, session.groupId)) {
        delete session.tabsByTarget[target];
        delete session.baselineTokenSignatures[target];
        return undefined;
      }
      return tab;
    } catch {
      delete session.tabsByTarget[target];
      delete session.baselineTokenSignatures[target];
      return undefined;
    }
  }))).filter((tab): tab is chrome.tabs.Tab => Boolean(tab));

  if (!survivingTabs.length) {
    delete session.windowId;
    delete session.groupId;
    return session;
  }

  session.windowId = survivingTabs[0].windowId;
  if (session.groupId !== undefined && !survivingTabs.some((tab) => tab.groupId === session.groupId)) {
    delete session.groupId;
  }
  return session;
}

async function closeTrackedTabs(session: PortalRecoverySession, tabs: PortalRecoveryTabsLike): Promise<void> {
  const entries = Object.entries(session.tabsByTarget) as Array<[AccessSetupTarget, number]>;
  await Promise.allSettled(entries.map(async ([target, tabId]) => {
    try {
      const tab = await tabs.get(tabId);
      if (isManagedPortalRecoveryTab(tab, target, session.groupId)) {
        await tabs.remove(tabId);
      }
    } catch {
      // Already-closed tabs need no cleanup.
    }
  }));
}

function isTargetRecoveryComplete(
  session: PortalRecoverySession,
  target: AccessSetupTarget,
  tokenStatus: TokenStatus
): boolean {
  return hasPortalRecoveryTokenChanged(target, session.baselineTokenSignatures[target], tokenStatus);
}

export function hasPortalRecoveryTokenChanged(
  target: AccessSetupTarget,
  baselineSignature: string | undefined,
  tokenStatus: TokenStatus
): boolean {
  return hasRequiredPortalToken(target, tokenStatus)
    && getTargetTokenSignature(tokenStatus, target) !== baselineSignature;
}

export function getPortalRecoveryTokenSignature(tokenStatus: TokenStatus, target: AccessSetupTarget): string {
  return getTargetTokenSignature(tokenStatus, target);
}

function getTargetTokenSignature(tokenStatus: TokenStatus, target: AccessSetupTarget): string {
  const token = getTargetTokenStatus(tokenStatus, target);
  if (!token?.hasToken || token.isExpired) {
    return "missing";
  }
  return [
    token.tenantId || "",
    token.principalId || "",
    token.capturedAt || 0,
    token.expiresAt || "",
    [...(token.grantedScopes || [])].sort((a, b) => a.localeCompare(b)).join(",")
  ].join("|");
}

function getTargetTokenStatus(tokenStatus: TokenStatus, target: AccessSetupTarget): TokenStatusEntry | undefined {
  if (target === "azureRole") {
    return tokenStatus.azureManagement;
  }
  return tokenStatus.graphTargets?.[target] || tokenStatus.graph;
}

function isPortalRecoveryUrlForTarget(url: string | undefined, target: AccessSetupTarget): boolean {
  if (!url) {
    return false;
  }
  try {
    const parsed = new URL(url);
    const expected = new URL(ENTRA_PORTAL_URLS[target]);
    const expectedBlade = expected.hash.match(/~\/([^/?]+)/)?.[1];
    return parsed.protocol === "https:" && parsed.hostname === "entra.microsoft.com" && Boolean(expectedBlade && parsed.hash.includes(`~/${expectedBlade}`));
  } catch {
    return false;
  }
}

function isManagedPortalRecoveryTab(
  tab: chrome.tabs.Tab,
  target: AccessSetupTarget,
  groupId: number | undefined
): boolean {
  const url = tab.url || tab.pendingUrl;
  if (!url) {
    return groupId === undefined || tab.groupId === groupId;
  }
  if (isPortalRecoveryUrlForTarget(url, target)) {
    return true;
  }
  if (isMicrosoftAuthenticationUrl(url)) {
    return true;
  }
  if (groupId === undefined || tab.groupId !== groupId) {
    return false;
  }
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === "entra.microsoft.com";
  } catch {
    return false;
  }
}

async function buildPortalRecoveryStatus(
  session: PortalRecoverySession,
  tabs: PortalRecoveryTabsLike,
  now: number
): Promise<PortalRecoveryStatus> {
  const entries = Object.entries(session.tabsByTarget) as Array<[AccessSetupTarget, number]>;
  if (!entries.length) {
    return idlePortalRecoveryStatus();
  }

  const interactionChecks = await Promise.all(entries.map(async ([target, tabId]) => {
    try {
      const tab = await tabs.get(tabId);
      const url = tab.url || tab.pendingUrl;
      return !url || isMicrosoftAuthenticationUrl(url) ? target : undefined;
    } catch {
      // Pruning handles missing tabs before status inspection.
      return undefined;
    }
  }));

  const managedTargets = entries.map(([target]) => target);
  const interactionTargets = interactionChecks.filter((target): target is AccessSetupTarget => Boolean(target));
  const timedOut = now - session.createdAt >= PORTAL_RECOVERY_INTERACTION_TIMEOUT_MS;
  const requiresInteraction = interactionTargets.length > 0 || timedOut;
  return {
    state: requiresInteraction ? "interactionRequired" : "waiting",
    managedTargets,
    interactionTargets: interactionTargets.length ? uniqueTargets(interactionTargets) : timedOut ? managedTargets : [],
    grouped: session.groupId !== undefined,
    ...(requiresInteraction ? {
      interactionReason: interactionTargets.length ? "signIn" as const : "microsoftPrompt" as const
    } : {})
  };
}

function idlePortalRecoveryStatus(): PortalRecoveryStatus {
  return {
    state: "idle",
    managedTargets: [],
    interactionTargets: [],
    grouped: false
  };
}

function isMicrosoftAuthenticationUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && (
      parsed.hostname === "login.microsoftonline.com"
      || parsed.hostname.endsWith(".login.microsoftonline.com")
      || parsed.hostname === "login.windows.net"
    );
  } catch {
    return false;
  }
}

async function closeSessionTargets(
  session: PortalRecoverySession,
  targets: AccessSetupTarget[],
  tabs: PortalRecoveryTabsLike
): Promise<AccessSetupTarget[]> {
  const entries = targets.flatMap((target) => {
    const tabId = session.tabsByTarget[target];
    return tabId === undefined ? [] : [{ target, tabId }];
  });
  if (!entries.length) {
    return [];
  }

  try {
    await tabs.remove(entries.map((entry) => entry.tabId));
    for (const { target } of entries) {
      delete session.tabsByTarget[target];
      delete session.baselineTokenSignatures[target];
    }
    return entries.map((entry) => entry.target);
  } catch {
    const closedTargets: AccessSetupTarget[] = [];
    for (const { target, tabId } of entries) {
      try {
        await tabs.remove(tabId);
        delete session.tabsByTarget[target];
        delete session.baselineTokenSignatures[target];
        closedTargets.push(target);
      } catch {
        // Keep failed tab removals tracked so a later completion or timeout can retry them.
      }
    }
    return closedTargets;
  }
}

async function saveOrRemoveSession(session: PortalRecoverySession, storage: PortalRecoveryStorageLike): Promise<void> {
  if (!Object.keys(session.tabsByTarget).length) {
    await storage.remove(PORTAL_RECOVERY_SESSION_KEY);
  } else {
    await storage.set({ [PORTAL_RECOVERY_SESSION_KEY]: session });
  }
}

async function loadPortalRecoverySession(storage: PortalRecoveryStorageLike): Promise<PortalRecoverySession | undefined> {
  const result = await storage.get(PORTAL_RECOVERY_SESSION_KEY);
  const value = result[PORTAL_RECOVERY_SESSION_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || typeof record.createdAt !== "number" || !Number.isFinite(record.createdAt)) {
    return undefined;
  }
  const tabsByTarget = sanitizeTargetNumbers(record.tabsByTarget);
  const baselineTokenSignatures = sanitizeTargetStrings(record.baselineTokenSignatures);
  return {
    version: 1,
    createdAt: record.createdAt,
    tabsByTarget,
    baselineTokenSignatures,
    ...(typeof record.groupId === "number" && Number.isInteger(record.groupId) ? { groupId: record.groupId } : {}),
    ...(typeof record.windowId === "number" && Number.isInteger(record.windowId) ? { windowId: record.windowId } : {})
  };
}

function sanitizeTargetNumbers(value: unknown): Partial<Record<AccessSetupTarget, number>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(Object.entries(value).filter(([target, tabId]) =>
    isAccessSetupTarget(target) && typeof tabId === "number" && Number.isInteger(tabId) && tabId >= 0
  ));
}

function sanitizeTargetStrings(value: unknown): Partial<Record<AccessSetupTarget, string>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(Object.entries(value).filter(([target, signature]) =>
    isAccessSetupTarget(target) && typeof signature === "string" && signature.length <= 2048
  ));
}

function sanitizeTargetArray(value: unknown): AccessSetupTarget[] {
  return Array.isArray(value) ? uniqueTargets(value.filter(isAccessSetupTarget)) : [];
}

function uniqueTargets(targets: AccessSetupTarget[]): AccessSetupTarget[] {
  return [...new Set(targets.filter(isAccessSetupTarget))];
}

function isAccessSetupTarget(value: unknown): value is AccessSetupTarget {
  return value === "directoryRole" || value === "pimGroup" || value === "azureRole";
}

function enqueuePortalRecoveryMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = portalRecoveryMutationQueue.then(operation);
  portalRecoveryMutationQueue = result.then(() => undefined, () => undefined);
  return result;
}
