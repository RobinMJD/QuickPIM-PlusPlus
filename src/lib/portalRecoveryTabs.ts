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
export const PORTAL_RECOVERY_ABSOLUTE_TTL_MS = 90 * 60_000;
export const PORTAL_RECOVERY_INTERACTION_TIMEOUT_MS = 45_000;
export const PORTAL_RECOVERY_AUTH_PROBE_GRACE_MS = 8_000;
export const PORTAL_RECOVERY_CLEANUP_ALARM_NAME = "quickPimPortalRecoveryCleanup";
const PORTAL_RECOVERY_MAX_FUTURE_CLOCK_SKEW_MS = 5 * 60_000;
const PORTAL_RECOVERY_URL_MARKER = "quickpimRecovery";

interface PortalRecoverySession {
  version: 1;
  /** Immutable lifetime boundary for this recovery journey. */
  createdAt: number;
  lastProgressAt: number;
  lastRequestedAt: number;
  groupId?: number;
  windowId?: number;
  tabsByTarget: Partial<Record<AccessSetupTarget, number>>;
  baselineTokenSignatures: Partial<Record<AccessSetupTarget, string>>;
  deferredTargets: AccessSetupTarget[];
  authenticationTarget?: AccessSetupTarget;
  authenticationObserved?: boolean;
  lastKnownUrlsByTarget: Partial<Record<AccessSetupTarget, string>>;
}

export interface PortalRecoveryTabsLike {
  create(properties: chrome.tabs.CreateProperties): Promise<chrome.tabs.Tab>;
  get(tabId: number): Promise<chrome.tabs.Tab>;
  group(options: chrome.tabs.GroupOptions): Promise<number>;
  remove(tabIds: number | number[]): Promise<void>;
  query?(queryInfo: chrome.tabs.QueryInfo): Promise<chrome.tabs.Tab[]>;
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
    let session = await loadPortalRecoverySession(apis.storage, now);
    if (session) {
      session = await pruneMissingOrNavigatedTabs(session, apis.tabs, now);
    }
    if (session && await shouldExpirePortalRecoverySession(session, apis.tabs, now)) {
      await closeTrackedTabs(session, apis.tabs);
      await apis.storage.remove(PORTAL_RECOVERY_SESSION_KEY);
      session = undefined;
    }

    session = session || newPortalRecoverySession(now);
    const advancedTargets = await advanceAuthenticationStage(session, tokenStatus, apis, now);
    const managedBeforeOpen = getManagedTargets(session);
    const reusedTargets = targets.filter((target) => managedBeforeOpen.includes(target));
    const missingTargets = targets.filter((target) => !managedBeforeOpen.includes(target));
    const openedTargets: AccessSetupTarget[] = [...advancedTargets];

    for (const target of missingTargets) {
      session.baselineTokenSignatures[target] = getTargetTokenSignature(tokenStatus, target);
    }

    if (session.authenticationTarget) {
      session.deferredTargets = uniqueTargets([...session.deferredTargets, ...missingTargets]);
    } else if (shouldStageAuthentication(missingTargets, tokenStatus)) {
      const leaderCandidates = [...missingTargets];
      const failedTargets: AccessSetupTarget[] = [];
      while (leaderCandidates.length) {
        const leader = leaderCandidates.shift()!;
        if (await openRecoveryTarget(session, leader, apis.tabs)) {
          session.authenticationTarget = leader;
          session.authenticationObserved = false;
          session.deferredTargets = uniqueTargets([
            ...session.deferredTargets,
            ...failedTargets,
            ...leaderCandidates
          ]);
          openedTargets.push(leader);
          break;
        }
        failedTargets.push(leader);
      }
    } else {
      for (const target of missingTargets) {
        if (await openRecoveryTarget(session, target, apis.tabs)) {
          openedTargets.push(target);
        }
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

    session.lastRequestedAt = now;
    session.groupId = await ensurePortalRecoveryGroup(session, openedTargets, apis);
    await apis.storage.set({ [PORTAL_RECOVERY_SESSION_KEY]: session });
    return {
      requestedCount: targets.length,
      openedCount: openedTargets.length,
      reusedCount: reusedTargets.length,
      managedCount: targets.filter((target) => getManagedTargets(session).includes(target)).length,
      grouped: session.groupId !== undefined
    };
  });
}

export async function getPortalRecoveryStatus(
  apis: PortalRecoveryApis,
  now = Date.now(),
  tokenStatus?: TokenStatus
): Promise<PortalRecoveryStatus> {
  return enqueuePortalRecoveryMutation(async () => {
    let session = await loadPortalRecoverySession(apis.storage, now);
    if (!session) {
      return idlePortalRecoveryStatus();
    }
    session = await pruneMissingOrNavigatedTabs(session, apis.tabs, now);
    if (tokenStatus) {
      await advanceAuthenticationStage(session, tokenStatus, apis, now);
    }
    await saveOrRemoveSession(session, apis.storage);
    return buildPortalRecoveryStatus(session, apis.tabs, now);
  });
}

export async function focusPortalRecoveryTabs(
  apis: PortalRecoveryApis,
  now = Date.now(),
  tokenStatus?: TokenStatus
): Promise<PortalRecoveryFocusResult> {
  return enqueuePortalRecoveryMutation(async () => {
    let session = await loadPortalRecoverySession(apis.storage, now);
    if (!session) {
      return { focused: false, status: idlePortalRecoveryStatus() };
    }
    session = await pruneMissingOrNavigatedTabs(session, apis.tabs, now);
    if (tokenStatus) {
      await advanceAuthenticationStage(session, tokenStatus, apis, now);
    }
    await saveOrRemoveSession(session, apis.storage);
    const status = await buildPortalRecoveryStatus(session, apis.tabs, now);
    const preferredTargets = status.interactionTargets.length
      ? status.interactionTargets
      : session.authenticationTarget ? [session.authenticationTarget] : status.managedTargets;
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
  return openPortalRecoveryTabs(requestedTargets, baselineTokenStatus, apis, now);
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
    const authenticationContextTarget = session.authenticationTarget;
    await advanceAuthenticationStage(session, tokenStatus, apis, Date.now());
    const recoveryStatus = await buildPortalRecoveryStatus(session, apis.tabs, Date.now());
    const completedTargets = getManagedTargets(session)
      .filter((target) => isTargetRecoveryComplete(session, target, tokenStatus));
    const safeCompletedTargets = recoveryStatus.state === "interactionRequired" && authenticationContextTarget
      ? completedTargets.filter((target) => target !== authenticationContextTarget)
      : completedTargets;

    const closedTargets = await closeSessionTargets(session, safeCompletedTargets, apis.tabs);
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
    const targets = uniqueTargets(requestedTargets).filter((target) => getManagedTargets(session!).includes(target));
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
    let session = await loadPortalRecoverySession(apis.storage, now);
    if (!session) {
      return [];
    }
    session = await pruneMissingOrNavigatedTabs(session, apis.tabs, now);
    if (!await shouldExpirePortalRecoverySession(session, apis.tabs, now)) {
      await saveOrRemoveSession(session, apis.storage);
      return [];
    }
    const targets = getManagedTargets(session);
    const closedTargets = await closeSessionTargets(session, targets, apis.tabs);
    await saveOrRemoveSession(session, apis.storage);
    return closedTargets;
  });
}

export async function isPortalRecoveryManagedTabId(
  tabId: number,
  apis: PortalRecoveryApis,
  now = Date.now()
): Promise<boolean> {
  if (!Number.isInteger(tabId) || tabId < 0) return false;
  return enqueuePortalRecoveryMutation(async () => {
    let session = await loadPortalRecoverySession(apis.storage, now);
    if (!session) return false;
    session = await pruneMissingOrNavigatedTabs(session, apis.tabs, now);
    await saveOrRemoveSession(session, apis.storage);
    return Object.values(session.tabsByTarget).includes(tabId);
  });
}

function newPortalRecoverySession(now: number): PortalRecoverySession {
  return {
    version: 1,
    createdAt: now,
    lastProgressAt: now,
    lastRequestedAt: now,
    tabsByTarget: {},
    baselineTokenSignatures: {},
    deferredTargets: [],
    lastKnownUrlsByTarget: {}
  };
}

function shouldStageAuthentication(targets: AccessSetupTarget[], tokenStatus: TokenStatus): boolean {
  return targets.length > 1 && targets.some((target) => !hasRequiredPortalToken(target, tokenStatus));
}

function hasUsablePortalSessionHint(
  tokenStatus: TokenStatus,
  targets: AccessSetupTarget[]
): boolean {
  const candidates: Array<TokenStatusEntry | undefined> = targets.map((target) =>
    getTargetTokenStatus(tokenStatus, target)
  );
  return candidates.some((token) => Boolean(token?.hasToken && !token.isExpired));
}

async function openRecoveryTarget(
  session: PortalRecoverySession,
  target: AccessSetupTarget,
  tabs: PortalRecoveryTabsLike
): Promise<boolean> {
  try {
    const tab = await tabs.create({
      url: buildPortalRecoveryUrl(target, session.createdAt),
      active: false,
      ...(session.windowId !== undefined ? { windowId: session.windowId } : {})
    });
    if (typeof tab.id !== "number") return false;
    session.tabsByTarget[target] = tab.id;
    session.windowId ??= tab.windowId;
    session.lastKnownUrlsByTarget[target] = tab.url || tab.pendingUrl || "";
    return true;
  } catch {
    return false;
  }
}

async function advanceAuthenticationStage(
  session: PortalRecoverySession,
  tokenStatus: TokenStatus,
  apis: PortalRecoveryApis,
  now: number
): Promise<AccessSetupTarget[]> {
  const authenticationTarget = session.authenticationTarget;
  if (!authenticationTarget) {
    if (!session.deferredTargets.length) return [];
    const pendingTargets = [...session.deferredTargets];
    session.deferredTargets = [];
    const openedTargets: AccessSetupTarget[] = [];
    if (hasUsablePortalSessionHint(tokenStatus, pendingTargets)) {
      for (const target of pendingTargets) {
        if (await openRecoveryTarget(session, target, apis.tabs)) openedTargets.push(target);
        else session.deferredTargets.push(target);
      }
    } else {
      const failedTargets: AccessSetupTarget[] = [];
      while (pendingTargets.length) {
        const leader = pendingTargets.shift()!;
        if (await openRecoveryTarget(session, leader, apis.tabs)) {
          session.authenticationTarget = leader;
          session.authenticationObserved = false;
          openedTargets.push(leader);
          break;
        }
        failedTargets.push(leader);
      }
      session.deferredTargets.push(...failedTargets, ...pendingTargets);
    }
    session.groupId = await ensurePortalRecoveryGroup(session, openedTargets, apis);
    return openedTargets;
  }
  const tabId = session.tabsByTarget[authenticationTarget];
  if (tabId === undefined) {
    delete session.authenticationTarget;
    delete session.authenticationObserved;
    return [];
  }

  let tab: chrome.tabs.Tab;
  try {
    tab = await apis.tabs.get(tabId);
  } catch {
    return [];
  }
  const url = tab.url || tab.pendingUrl;
  if (!url || isMicrosoftAuthenticationUrl(url)) {
    session.authenticationObserved = true;
    return [];
  }

  const tokenChanged = isTargetRecoveryComplete(session, authenticationTarget, tokenStatus);
  const returnedFromAuthentication = session.authenticationObserved && isPortalRecoveryUrlForTarget(url, authenticationTarget);
  const signedInWithoutPrompt = !session.authenticationObserved
    && now - session.lastProgressAt >= PORTAL_RECOVERY_AUTH_PROBE_GRACE_MS
    && isPortalRecoveryUrlForTarget(url, authenticationTarget);
  if (!tokenChanged && !returnedFromAuthentication && !signedInWithoutPrompt) {
    return [];
  }

  const deferredTargets = [...session.deferredTargets];
  session.deferredTargets = [];
  delete session.authenticationTarget;
  delete session.authenticationObserved;
  const openedTargets: AccessSetupTarget[] = [];
  for (const target of deferredTargets) {
    if (await openRecoveryTarget(session, target, apis.tabs)) {
      openedTargets.push(target);
    } else {
      session.deferredTargets.push(target);
    }
  }
  session.groupId = await ensurePortalRecoveryGroup(session, openedTargets, apis);
  return openedTargets;
}

function getManagedTargets(session: PortalRecoverySession): AccessSetupTarget[] {
  return uniqueTargets([
    ...Object.keys(session.tabsByTarget).filter(isAccessSetupTarget),
    ...session.deferredTargets
  ]);
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
  tabs: PortalRecoveryTabsLike,
  now = Date.now()
): Promise<PortalRecoverySession> {
  const entries = Object.entries(session.tabsByTarget) as Array<[AccessSetupTarget, number]>;
  const survivingTabs = (await Promise.all(entries.map(async ([target, tabId]) => {
    try {
      const tab = await tabs.get(tabId);
      if (!isManagedPortalRecoveryTab(tab, target, session.groupId, session.authenticationTarget === target && session.authenticationObserved === true)) {
        delete session.tabsByTarget[target];
        delete session.baselineTokenSignatures[target];
        delete session.lastKnownUrlsByTarget[target];
        if (session.authenticationTarget === target) {
          delete session.authenticationTarget;
          delete session.authenticationObserved;
        }
        return undefined;
      }
      const currentUrl = tab.url || tab.pendingUrl || "";
      if (
        session.lastKnownUrlsByTarget[target] !== currentUrl
        && isConfirmedPortalRecoveryProgress(currentUrl, target)
      ) {
        session.lastKnownUrlsByTarget[target] = currentUrl;
        session.lastProgressAt = now;
      } else if (session.lastKnownUrlsByTarget[target] !== currentUrl) {
        session.lastKnownUrlsByTarget[target] = currentUrl;
      }
      return tab;
    } catch {
      delete session.tabsByTarget[target];
      delete session.baselineTokenSignatures[target];
      delete session.lastKnownUrlsByTarget[target];
      if (session.authenticationTarget === target) {
        delete session.authenticationTarget;
        delete session.authenticationObserved;
      }
      return undefined;
    }
  }))).filter((tab): tab is chrome.tabs.Tab => Boolean(tab));

  if (!survivingTabs.length) {
    delete session.windowId;
    delete session.groupId;
  } else {
    session.windowId = survivingTabs[0].windowId;
    if (session.groupId !== undefined && !survivingTabs.some((tab) => tab.groupId === session.groupId)) {
      delete session.groupId;
    }
  }

  if (survivingTabs.length < entries.length) {
    await restoreTaggedRecoveryTabs(session, tabs, now);
  }
  return session;
}

async function restoreTaggedRecoveryTabs(
  session: PortalRecoverySession,
  tabs: PortalRecoveryTabsLike,
  now: number
): Promise<void> {
  if (!tabs.query) return;
  let candidates: chrome.tabs.Tab[];
  try {
    candidates = await tabs.query({ url: ["https://entra.microsoft.com/*"] });
  } catch {
    return;
  }

  const recovered = new Set<AccessSetupTarget>();
  for (const tab of candidates.sort((left, right) => (left.id ?? Number.MAX_SAFE_INTEGER) - (right.id ?? Number.MAX_SAFE_INTEGER))) {
    const target = getTaggedRecoveryTarget(tab.url || tab.pendingUrl, session.createdAt);
    if (!target || recovered.has(target) || typeof tab.id !== "number" || typeof session.tabsByTarget[target] === "number") continue;
    session.tabsByTarget[target] = tab.id;
    session.windowId ??= tab.windowId;
    session.lastKnownUrlsByTarget[target] = tab.url || tab.pendingUrl || "";
    session.lastProgressAt = now;
    if (tab.groupId !== undefined && tab.groupId >= 0) {
      session.groupId ??= tab.groupId;
    }
    recovered.add(target);
  }
}

async function closeTrackedTabs(session: PortalRecoverySession, tabs: PortalRecoveryTabsLike): Promise<void> {
  const entries = Object.entries(session.tabsByTarget) as Array<[AccessSetupTarget, number]>;
  await Promise.allSettled(entries.map(async ([target, tabId]) => {
    try {
      const tab = await tabs.get(tabId);
      if (isManagedPortalRecoveryTab(
        tab,
        target,
        session.groupId,
        session.authenticationTarget === target && session.authenticationObserved === true
      )) {
        await tabs.remove(tabId);
      }
    } catch {
      // Already-closed tabs need no cleanup.
    }
  }));
}

async function shouldExpirePortalRecoverySession(
  session: PortalRecoverySession,
  tabs: PortalRecoveryTabsLike,
  now: number
): Promise<boolean> {
  if (now - session.createdAt >= PORTAL_RECOVERY_ABSOLUTE_TTL_MS) {
    return true;
  }
  if (now - session.lastProgressAt < PORTAL_RECOVERY_SESSION_TTL_MS) {
    return false;
  }

  const entries = Object.entries(session.tabsByTarget) as Array<[AccessSetupTarget, number]>;
  const interactionStates = await Promise.all(entries.map(async ([target, tabId]) => {
    try {
      const tab = await tabs.get(tabId);
      const url = tab.url || tab.pendingUrl;
      return !url
        || isMicrosoftAuthenticationUrl(url)
        || (session.authenticationTarget === target && session.authenticationObserved === true && !isPortalRecoveryUrlForTarget(url, target));
    } catch {
      return false;
    }
  }));
  return !interactionStates.some(Boolean);
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
  const currentSignature = getTargetTokenSignature(tokenStatus, target);
  return hasRequiredPortalToken(target, tokenStatus)
    && currentSignature !== baselineSignature
    && isCompatibleRecoveryIdentity(baselineSignature, currentSignature);
}

function isCompatibleRecoveryIdentity(baselineSignature: string | undefined, currentSignature: string): boolean {
  if (!baselineSignature || baselineSignature === "missing") return true;
  const [baselineTenant, baselinePrincipal] = baselineSignature.split("|", 2);
  const [currentTenant, currentPrincipal] = currentSignature.split("|", 2);
  return Boolean(
    baselineTenant
    && baselinePrincipal
    && baselineTenant.toLowerCase() === currentTenant.toLowerCase()
    && baselinePrincipal.toLowerCase() === currentPrincipal.toLowerCase()
  );
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

function isConfirmedPortalRecoveryProgress(url: string, target: AccessSetupTarget): boolean {
  return isMicrosoftAuthenticationUrl(url) || isPortalRecoveryUrlForTarget(url, target);
}

function buildPortalRecoveryUrl(target: AccessSetupTarget, createdAt: number): string {
  const url = new URL(ENTRA_PORTAL_URLS[target]);
  url.searchParams.set(PORTAL_RECOVERY_URL_MARKER, `${target}.${createdAt}`);
  return url.toString();
}

function getTaggedRecoveryTarget(url: string | undefined, createdAt: number): AccessSetupTarget | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.hostname !== "entra.microsoft.com") return undefined;
    const marker = parsed.searchParams.get(PORTAL_RECOVERY_URL_MARKER);
    if (!marker) return undefined;
    const separator = marker.lastIndexOf(".");
    if (separator < 0 || Number(marker.slice(separator + 1)) !== createdAt) return undefined;
    const target = marker.slice(0, separator);
    return isAccessSetupTarget(target) && isPortalRecoveryUrlForTarget(url, target) ? target : undefined;
  } catch {
    return undefined;
  }
}

function isManagedPortalRecoveryTab(
  tab: chrome.tabs.Tab,
  target: AccessSetupTarget,
  groupId: number | undefined,
  authenticationChainObserved = false
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
    return parsed.protocol === "https:" && (
      parsed.hostname === "entra.microsoft.com"
      // A managed tab that was already observed on a Microsoft sign-in page
      // can legitimately pass through an enterprise federation host. This
      // keeps ownership only; token capture remains restricted to Entra.
      || authenticationChainObserved
    );
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

  const managedTargets = getManagedTargets(session);
  const interactionTargets = interactionChecks.filter((target): target is AccessSetupTarget => Boolean(target));
  const timedOut = session.authenticationObserved === true
    && now - session.lastProgressAt >= PORTAL_RECOVERY_INTERACTION_TIMEOUT_MS;
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
      || parsed.hostname === "login.microsoft.com"
      || parsed.hostname === "login.live.com"
      || parsed.hostname === "account.activedirectory.windowsazure.com"
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
  const managedTargets = targets.filter((target) => getManagedTargets(session).includes(target));
  const entries = managedTargets.flatMap((target) => {
    const tabId = session.tabsByTarget[target];
    return tabId === undefined ? [] : [{ target, tabId }];
  });
  const deferredTargets = managedTargets.filter((target) => session.tabsByTarget[target] === undefined);
  session.deferredTargets = session.deferredTargets.filter((target) => !deferredTargets.includes(target));
  for (const target of deferredTargets) {
    delete session.baselineTokenSignatures[target];
  }
  if (session.authenticationTarget && managedTargets.includes(session.authenticationTarget)) {
    delete session.authenticationTarget;
    delete session.authenticationObserved;
  }
  if (!entries.length) return deferredTargets;

  try {
    await tabs.remove(entries.map((entry) => entry.tabId));
    for (const { target } of entries) {
      delete session.tabsByTarget[target];
      delete session.baselineTokenSignatures[target];
      delete session.lastKnownUrlsByTarget[target];
    }
    return [...deferredTargets, ...entries.map((entry) => entry.target)];
  } catch {
    const closedTargets: AccessSetupTarget[] = [];
    for (const { target, tabId } of entries) {
      try {
        await tabs.remove(tabId);
        delete session.tabsByTarget[target];
        delete session.baselineTokenSignatures[target];
        delete session.lastKnownUrlsByTarget[target];
        closedTargets.push(target);
      } catch {
        // Keep failed tab removals tracked so a later completion or timeout can retry them.
      }
    }
    return [...deferredTargets, ...closedTargets];
  }
}

async function saveOrRemoveSession(session: PortalRecoverySession, storage: PortalRecoveryStorageLike): Promise<void> {
  if (!getManagedTargets(session).length) {
    await storage.remove(PORTAL_RECOVERY_SESSION_KEY);
  } else {
    await storage.set({ [PORTAL_RECOVERY_SESSION_KEY]: session });
  }
}

async function loadPortalRecoverySession(
  storage: PortalRecoveryStorageLike,
  now = Date.now()
): Promise<PortalRecoverySession | undefined> {
  const result = await storage.get(PORTAL_RECOVERY_SESSION_KEY);
  const value = result[PORTAL_RECOVERY_SESSION_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1
    || typeof record.createdAt !== "number"
    || !Number.isFinite(record.createdAt)
    || record.createdAt <= 0
    || record.createdAt > now + PORTAL_RECOVERY_MAX_FUTURE_CLOCK_SKEW_MS
  ) {
    return undefined;
  }
  const tabsByTarget = sanitizeTargetNumbers(record.tabsByTarget);
  const baselineTokenSignatures = sanitizeTargetStrings(record.baselineTokenSignatures);
  const deferredTargets = sanitizeTargetArray(record.deferredTargets)
    .filter((target) => tabsByTarget[target] === undefined);
  const authenticationTarget = isAccessSetupTarget(record.authenticationTarget)
    && tabsByTarget[record.authenticationTarget] !== undefined
    ? record.authenticationTarget
    : undefined;
  const lastProgressAt = sanitizeSessionTimestamp(record.lastProgressAt, record.createdAt, now);
  const lastRequestedAt = sanitizeSessionTimestamp(record.lastRequestedAt, record.createdAt, now);
  return {
    version: 1,
    createdAt: record.createdAt,
    lastProgressAt,
    lastRequestedAt,
    tabsByTarget,
    baselineTokenSignatures,
    deferredTargets,
    lastKnownUrlsByTarget: sanitizeTargetStrings(record.lastKnownUrlsByTarget),
    ...(authenticationTarget ? { authenticationTarget } : {}),
    ...(authenticationTarget && record.authenticationObserved === true ? { authenticationObserved: true } : {}),
    ...(typeof record.groupId === "number" && Number.isInteger(record.groupId) ? { groupId: record.groupId } : {}),
    ...(typeof record.windowId === "number" && Number.isInteger(record.windowId) ? { windowId: record.windowId } : {})
  };
}

function sanitizeSessionTimestamp(value: unknown, fallback: number, now: number): number {
  return typeof value === "number"
    && Number.isFinite(value)
    && value >= fallback
    && value <= now + PORTAL_RECOVERY_MAX_FUTURE_CLOCK_SKEW_MS
    ? value
    : fallback;
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
