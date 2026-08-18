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
export const PORTAL_RECOVERY_VERIFY_ALARM_NAME = "quickPimPortalRecoveryVerify";
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
  ungroup?(tabIds: number | number[]): Promise<void>;
  remove(tabIds: number | number[]): Promise<void>;
  query?(queryInfo: chrome.tabs.QueryInfo): Promise<chrome.tabs.Tab[]>;
  update?(tabId: number, updateProperties: chrome.tabs.UpdateProperties): Promise<chrome.tabs.Tab | undefined>;
}

export interface PortalRecoveryTabGroupsLike {
  update(groupId: number, updateProperties: chrome.tabGroups.UpdateProperties): Promise<chrome.tabGroups.TabGroup | undefined>;
  query?(queryInfo: chrome.tabGroups.QueryInfo): Promise<chrome.tabGroups.TabGroup[]>;
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
      await closeSessionTargets(session, getManagedTargets(session), apis.tabs);
      await saveOrRemoveSession(session, apis.storage);
      if (getManagedTargets(session).length) {
        // A transient tabs.remove failure must not prevent a different source
        // from joining a newly requested refresh. Keep ownership of the tabs
        // that could not be closed, but start a fresh journey generation so
        // older asynchronous checks cannot close newly opened tabs.
        renewPortalRecoverySession(session, tokenStatus, now);
      } else {
        session = undefined;
      }
    }

    await closeOrphanedPortalRecoveryTabsInternal(apis, session);

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
        if (await openRecoveryTarget(session, leader, apis)) {
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
        if (await openRecoveryTarget(session, target, apis)) {
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
    await persistRecoveryStateThenGroup(session, openedTargets, apis);
    return {
      requestedCount: targets.length,
      openedCount: openedTargets.length,
      reusedCount: reusedTargets.length,
      managedCount: targets.filter((target) => getManagedTargets(session).includes(target)).length,
      grouped: session.groupId !== undefined,
      journeyCreatedAt: session.createdAt
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
    if (await shouldExpirePortalRecoverySession(session, apis.tabs, now)) {
      await closeSessionTargets(session, getManagedTargets(session), apis.tabs);
      await saveOrRemoveSession(session, apis.storage);
      if (!getManagedTargets(session).length) {
        return idlePortalRecoveryStatus();
      }
    }
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
    if (await shouldExpirePortalRecoverySession(session, apis.tabs, now)) {
      await closeSessionTargets(session, getManagedTargets(session), apis.tabs);
      await saveOrRemoveSession(session, apis.storage);
      if (!getManagedTargets(session).length) {
        return { focused: false, status: idlePortalRecoveryStatus() };
      }
    }
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

export async function closePortalRecoveryTabsForTargets(
  requestedTargets: AccessSetupTarget[],
  apis: PortalRecoveryApis,
  expectedJourneyCreatedAt?: number
): Promise<AccessSetupTarget[]> {
  return enqueuePortalRecoveryMutation(async () => {
    let session = await loadPortalRecoverySession(apis.storage);
    if (!session) {
      return [];
    }
    if (
      expectedJourneyCreatedAt !== undefined
      && session.createdAt !== expectedJourneyCreatedAt
    ) {
      return [];
    }
    session = await pruneMissingOrNavigatedTabs(session, apis.tabs);
    const targets = uniqueTargets(requestedTargets).filter((target) => getManagedTargets(session!).includes(target));
    const closedTargets = await closeSessionTargets(session, targets, apis.tabs);
    await saveOrRemoveSession(session, apis.storage);
    return closedTargets;
  });
}

/**
 * Returns the immutable generation of the currently managed recovery journey.
 * Callers can pass it back to closePortalRecoveryTabsForTargets so an older,
 * slower API check cannot close tabs opened by a newer refresh.
 */
export async function getPortalRecoveryJourneyCreatedAt(
  apis: PortalRecoveryApis,
  now = Date.now()
): Promise<number | undefined> {
  return enqueuePortalRecoveryMutation(async () => {
    let session = await loadPortalRecoverySession(apis.storage, now);
    if (!session) return undefined;
    session = await pruneMissingOrNavigatedTabs(session, apis.tabs, now);
    if (await shouldExpirePortalRecoverySession(session, apis.tabs, now)) {
      await closeSessionTargets(session, getManagedTargets(session), apis.tabs);
    }
    await saveOrRemoveSession(session, apis.storage);
    return getManagedTargets(session).length ? session.createdAt : undefined;
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

/**
 * Removes recovery tabs that can be proven to belong to an older QuickPIM++
 * journey but are no longer represented by the durable recovery session.
 * Exact group metadata and URL markers keep this cleanup narrowly scoped.
 */
export async function closeOrphanedPortalRecoveryTabs(
  apis: PortalRecoveryApis,
  now = Date.now()
): Promise<number[]> {
  return enqueuePortalRecoveryMutation(async () => {
    const session = await loadPortalRecoverySession(apis.storage, now);
    return closeOrphanedPortalRecoveryTabsInternal(apis, session);
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
    if (await shouldExpirePortalRecoverySession(session, apis.tabs, now)) {
      await closeSessionTargets(session, getManagedTargets(session), apis.tabs);
    }
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

function renewPortalRecoverySession(
  session: PortalRecoverySession,
  tokenStatus: TokenStatus,
  now: number
): void {
  session.createdAt = now;
  session.lastProgressAt = now;
  session.lastRequestedAt = now;
  session.baselineTokenSignatures = Object.fromEntries(
    getManagedTargets(session).map((target) => [target, getTargetTokenSignature(tokenStatus, target)])
  );
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
  apis: PortalRecoveryApis
): Promise<boolean> {
  try {
    const tab = await apis.tabs.create({
      url: buildPortalRecoveryUrl(target, session.createdAt),
      active: false,
      ...(session.windowId !== undefined ? { windowId: session.windowId } : {})
    });
    if (typeof tab.id !== "number") return false;
    session.tabsByTarget[target] = tab.id;
    session.windowId ??= tab.windowId;
    session.lastKnownUrlsByTarget[target] = tab.url || tab.pendingUrl || "";
    try {
      // Persist ownership before grouping or any later asynchronous work. A
      // popup can close immediately after the tab is created, and MV3 may then
      // suspend the worker before the outer operation reaches its final save.
      await apis.storage.set({ [PORTAL_RECOVERY_SESSION_KEY]: session });
    } catch {
      try {
        await apis.tabs.remove(tab.id);
      } catch {
        // One last persistence attempt is safer than losing ownership of a tab
        // when both browser APIs fail transiently at the same time.
        try {
          await apis.storage.set({ [PORTAL_RECOVERY_SESSION_KEY]: session });
          return true;
        } catch {
          // The exact URL marker lets the next lifecycle reconciliation remove
          // this otherwise untracked tab conservatively.
        }
      }
      delete session.tabsByTarget[target];
      delete session.lastKnownUrlsByTarget[target];
      if (!Object.keys(session.tabsByTarget).length) {
        delete session.windowId;
      }
      return false;
    }
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
        if (await openRecoveryTarget(session, target, apis)) openedTargets.push(target);
        else session.deferredTargets.push(target);
      }
    } else {
      const failedTargets: AccessSetupTarget[] = [];
      while (pendingTargets.length) {
        const leader = pendingTargets.shift()!;
        if (await openRecoveryTarget(session, leader, apis)) {
          session.authenticationTarget = leader;
          session.authenticationObserved = false;
          openedTargets.push(leader);
          break;
        }
        failedTargets.push(leader);
      }
      session.deferredTargets.push(...failedTargets, ...pendingTargets);
    }
    await persistRecoveryStateThenGroup(session, openedTargets, apis);
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

  // A deliberate account switch clears the previously stored token family in
  // the background worker. It is therefore safe to release deferred portal
  // pages when this leader receives any newer usable token. Final tab closure
  // still requires successful API checks for the currently stored identity.
  const tokenChanged = hasPortalRecoveryTokenGenerationChanged(
    authenticationTarget,
    session.baselineTokenSignatures[authenticationTarget],
    tokenStatus
  );
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
    if (await openRecoveryTarget(session, target, apis)) {
      openedTargets.push(target);
    } else {
      session.deferredTargets.push(target);
    }
  }
  await persistRecoveryStateThenGroup(session, openedTargets, apis);
  return openedTargets;
}

async function persistRecoveryStateThenGroup(
  session: PortalRecoverySession,
  openedTargets: AccessSetupTarget[],
  apis: PortalRecoveryApis
): Promise<void> {
  // The target ownership written by openRecoveryTarget is intentionally
  // immediate. Persist the higher-level authentication/deferred-target state
  // as a second durable checkpoint before grouping, because grouping can yield
  // long enough for an MV3 worker to be suspended after the popup closes.
  await apis.storage.set({ [PORTAL_RECOVERY_SESSION_KEY]: session });

  session.groupId = await ensurePortalRecoveryGroup(session, openedTargets, apis);
  try {
    await apis.storage.set({ [PORTAL_RECOVERY_SESSION_KEY]: session });
  } catch {
    // Ownership and logical intent are already durable. A later lifecycle
    // reconciliation can rediscover the exact marked tabs and group metadata.
  }
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
        await releasePortalRecoveryTabFromGroup(tab, session, tabs);
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

async function closeOrphanedPortalRecoveryTabsInternal(
  apis: PortalRecoveryApis,
  activeSession?: PortalRecoverySession
): Promise<number[]> {
  if (!apis.tabs.query) return [];
  const activeTabIds = new Set(Object.values(activeSession?.tabsByTarget || {}));
  const orphanTabIds = new Set<number>();

  try {
    const taggedTabs = await apis.tabs.query({ url: ["https://entra.microsoft.com/*"] });
    for (const tab of taggedTabs) {
      if (
        typeof tab.id === "number"
        && !activeTabIds.has(tab.id)
        && getPortalRecoveryMarker(tab.url || tab.pendingUrl)
      ) {
        orphanTabIds.add(tab.id);
      }
    }
  } catch {
    // Named-group discovery below can still recover grouped orphans.
  }

  if (apis.tabGroups?.query) {
    try {
      const groups = (await apis.tabGroups.query({ title: PORTAL_RECOVERY_GROUP_TITLE }))
        .filter((group) => group.title === PORTAL_RECOVERY_GROUP_TITLE && group.color === "blue")
        .filter((group) => group.id !== activeSession?.groupId);
      for (const group of groups) {
        let groupTabs: chrome.tabs.Tab[];
        try {
          groupTabs = await apis.tabs.query({ groupId: group.id });
        } catch {
          continue;
        }
        if (!groupTabs.length || !groupTabs.every(isRecognizablePortalRecoveryTab)) {
          continue;
        }
        for (const tab of groupTabs) {
          if (typeof tab.id === "number" && !activeTabIds.has(tab.id)) {
            orphanTabIds.add(tab.id);
          }
        }
      }
    } catch {
      // A browser without a working tabGroups query still gets marker cleanup.
    }
  }

  return removeTabIdsWithFallback([...orphanTabIds], apis.tabs);
}

async function removeTabIdsWithFallback(tabIds: number[], tabs: PortalRecoveryTabsLike): Promise<number[]> {
  if (!tabIds.length) return [];
  try {
    await tabs.remove(tabIds);
    return tabIds;
  } catch {
    const closed: number[] = [];
    for (const tabId of tabIds) {
      try {
        await tabs.remove(tabId);
        closed.push(tabId);
      } catch {
        // The next lifecycle reconciliation retries transient close failures.
      }
    }
    return closed;
  }
}

function isRecognizablePortalRecoveryTab(tab: chrome.tabs.Tab): boolean {
  const url = tab.url || tab.pendingUrl;
  if (!url) return true;
  return Boolean(
    getPortalRecoveryMarker(url)
    || isMicrosoftAuthenticationUrl(url)
    || (["directoryRole", "pimGroup", "azureRole"] as AccessSetupTarget[])
      .some((target) => isPortalRecoveryUrlForTarget(url, target))
  );
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

function hasPortalRecoveryTokenGenerationChanged(
  target: AccessSetupTarget,
  baselineSignature: string | undefined,
  tokenStatus: TokenStatus
): boolean {
  const currentSignature = getTargetTokenSignature(tokenStatus, target);
  return hasRequiredPortalToken(target, tokenStatus) && currentSignature !== baselineSignature;
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
  const marker = getPortalRecoveryMarker(url);
  return marker?.createdAt === createdAt ? marker.target : undefined;
}

function getPortalRecoveryMarker(
  url: string | undefined
): { target: AccessSetupTarget; createdAt: number } | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.hostname !== "entra.microsoft.com") return undefined;
    const marker = parsed.searchParams.get(PORTAL_RECOVERY_URL_MARKER);
    if (!marker) return undefined;
    const separator = marker.lastIndexOf(".");
    if (separator < 0) return undefined;
    const target = marker.slice(0, separator);
    const createdAt = Number(marker.slice(separator + 1));
    return isAccessSetupTarget(target)
      && Number.isFinite(createdAt)
      && createdAt > 0
      && isPortalRecoveryUrlForTarget(url, target)
      ? { target, createdAt }
      : undefined;
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
  if (!entries.length) return deferredTargets;

  const removableEntries: typeof entries = [];
  const releasedTargets: AccessSetupTarget[] = [];
  for (const entry of entries) {
    try {
      const tab = await tabs.get(entry.tabId);
      if (isSafeToClosePortalRecoveryTab(tab, entry.target, session)) {
        removableEntries.push(entry);
      } else {
        // The user repurposed this tab after QuickPIM++ opened it. Stop
        // managing it without closing the user's current page or leaving that
        // page inside the temporary QuickPIM++ recovery group.
        await releasePortalRecoveryTabFromGroup(tab, session, tabs);
        clearManagedTarget(session, entry.target);
        releasedTargets.push(entry.target);
      }
    } catch {
      // A missing tab is already closed. Pruning uses the same assumption.
      clearManagedTarget(session, entry.target);
      releasedTargets.push(entry.target);
    }
  }
  if (!removableEntries.length) {
    return [...deferredTargets, ...releasedTargets];
  }

  try {
    await tabs.remove(removableEntries.map((entry) => entry.tabId));
    for (const { target } of removableEntries) {
      clearManagedTarget(session, target);
    }
    return [...deferredTargets, ...releasedTargets, ...removableEntries.map((entry) => entry.target)];
  } catch {
    const closedTargets: AccessSetupTarget[] = [];
    for (const { target, tabId } of removableEntries) {
      try {
        await tabs.remove(tabId);
        clearManagedTarget(session, target);
        closedTargets.push(target);
      } catch {
        // Keep failed tab removals tracked so a later completion or timeout can retry them.
      }
    }
    return [...deferredTargets, ...releasedTargets, ...closedTargets];
  }
}

async function releasePortalRecoveryTabFromGroup(
  tab: chrome.tabs.Tab,
  session: PortalRecoverySession,
  tabs: PortalRecoveryTabsLike
): Promise<void> {
  if (
    !tabs.ungroup
    || typeof tab.id !== "number"
    || session.groupId === undefined
    || tab.groupId !== session.groupId
  ) {
    return;
  }
  try {
    await tabs.ungroup(tab.id);
  } catch {
    // Preserve the user's page even if the browser temporarily refuses to
    // detach it. QuickPIM++ never closes a tab after it has been repurposed.
  }
}

function clearManagedTarget(session: PortalRecoverySession, target: AccessSetupTarget): void {
  delete session.tabsByTarget[target];
  delete session.baselineTokenSignatures[target];
  delete session.lastKnownUrlsByTarget[target];
  if (session.authenticationTarget === target) {
    delete session.authenticationTarget;
    delete session.authenticationObserved;
  }
}

function isSafeToClosePortalRecoveryTab(
  tab: chrome.tabs.Tab,
  target: AccessSetupTarget,
  session: PortalRecoverySession
): boolean {
  const url = tab.url || tab.pendingUrl;
  if (!url) {
    return session.groupId === undefined || tab.groupId === session.groupId;
  }
  return isPortalRecoveryUrlForTarget(url, target)
    || isMicrosoftAuthenticationUrl(url)
    || getTaggedRecoveryTarget(url, session.createdAt) === target;
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
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    await storage.remove(PORTAL_RECOVERY_SESSION_KEY).catch(() => undefined);
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
    await storage.remove(PORTAL_RECOVERY_SESSION_KEY).catch(() => undefined);
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
