import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

describe("Microsoft PIM API contracts", () => {
  const background = readFileSync("src/background.ts", "utf8");
  const popup = readFileSync("src/popup/main.tsx", "utf8");
  const settings = readFileSync("src/settings/main.tsx", "utf8");

  test("loads Entra eligibility and active state from current-user schedule instances", () => {
    expect(background).toContain("roleEligibilityScheduleInstances/filterByCurrentUser(on='principal')");
    expect(background).toContain("roleAssignmentScheduleInstances/filterByCurrentUser(on='principal')");
    expect(background).not.toContain("roleEligibilitySchedules/filterByCurrentUser(on='principal')");
    expect(background).not.toContain("roleAssignmentSchedules/filterByCurrentUser(on='principal')");
  });

  test("loads PIM group eligibility and active state from current-user schedule instances", () => {
    expect(background).toContain("privilegedAccess/group/eligibilityScheduleInstances/filterByCurrentUser(on='principal')");
    expect(background).toContain("privilegedAccess/group/assignmentScheduleInstances/filterByCurrentUser(on='principal')");
    expect(background).not.toContain("privilegedAccess/group/eligibilitySchedules/filterByCurrentUser(on='principal')");
    expect(background).not.toContain("privilegedAccess/group/assignmentSchedules/filterByCurrentUser(on='principal')");
  });

  test("uses Azure assignment schedule instances so active roles can be evaluated for deactivation", () => {
    expect(background).toContain("Microsoft.Authorization/roleAssignmentScheduleInstances");
    expect(background).toContain("assignmentType");
  });

  test("loads subscription and management-group Azure scopes while retaining partial results", () => {
    expect(background).toContain("assertAtLeastOneAzureScopeSucceeded");
    expect(background).toContain("/providers/Microsoft.Management/managementGroups?api-version=2020-05-01");
    expect(background).toContain("PartialActivationDataError");
    expect(background).toContain('graphApiUrl("/v1.0/$batch")');
    expect(background).toContain("GRAPH_BATCH_REQUEST_LIMIT = 20");
    expect(background).toContain('results.every((result) => result.status === "rejected")');
    expect(background).not.toContain("assertAllSubscriptionsSucceeded");
  });

  test("does not reset extension storage while background refresh is writing caches", () => {
    expect(background).toContain("|| backgroundPreRefreshInFlight");
  });

  test("contains failures from fire-and-forget service worker tasks", () => {
    expect(background).toContain("function runBestEffort(operation: Promise<unknown>): void");
    expect(background).not.toContain("void runTrackedRequestMaintenance();");
    expect(background).not.toContain("void closeExpiredPortalRecoveryTabs(getPortalRecoveryApis());");
  });

  test("keeps bearer requests on allowlisted Microsoft endpoints without ambient credentials or redirects", () => {
    expect(background).toContain("assertAllowedApiUrl(url);");
    expect(background).toContain('credentials: "omit"');
    expect(background).toContain('redirect: "error"');
    expect(background).toContain('referrerPolicy: "no-referrer"');
  });

  test("reacts to per-installation browser sync records and queues local edits made during sync", () => {
    expect(background).toContain("isBrowserSyncPayloadStorageKey(key)");
    expect(background).toContain("isBrowserSyncDeviceStorageKey(key)");
    expect(background).toContain("runBrowserSync(true)");
    expect(background).toContain("const followUp = predecessor.catch(() => undefined).then(() => {");
    expect(background).toContain("return startBrowserSync();");
    expect(background).toContain("BROWSER_SYNC_TRANSIENT_RETRY_MINUTES");
    expect(background).toContain("isTransientBrowserSyncError(status.lastError)");
    expect(background).toMatch(/case "syncBrowserData":[\s\S]{0,400}return runBrowserSync\(true\);/);
    expect(background).not.toContain("await initializeBrowserSync();\n      return status;");
  });

  test("tracks submitted requests with bounded Microsoft status checks", () => {
    expect(background).toContain("persistTrackedSubmissionsBestEffort");
    expect(background).toContain("getAllowedResponseLocation");
    expect(background).toContain("roleAssignmentScheduleRequests/filterByCurrentUser(on='principal')");
    expect(background).toContain("privilegedAccess/group/assignmentScheduleRequests?");
    expect(background).toContain("REQUEST_TRACKING_AZURE_CONCURRENCY");
    expect(background).toContain("REQUEST_TRACKING_GRAPH_CONCURRENCY");
    expect(background).not.toContain("void initializeBackgroundRefresh();\nvoid initializeRequestTracking();");
    expect(background).not.toContain("chrome.cookies");
  });

  test("coalesces forced request-status checks and preserves reset boundaries", () => {
    expect(background).toContain("requestTrackingMaintenanceFollowUp");
    expect(background).toContain("pendingForcedTrackedRequestIds");
    expect(background).toContain("forceAllTrackedRequestMaintenance");
    expect(background).toContain("queueForcedTrackedRequestMaintenance(requestIds)");
    expect(background).toContain("return startTrackedRequestMaintenance(queuedRequestIds, true);");
    expect(background).not.toContain("const current = await requestTrackingMaintenanceInFlight;");
    expect(background).toMatch(/hasInFlightTasks:[\s\S]{0,500}requestTrackingMaintenanceFollowUp[\s\S]{0,300}browserSyncFollowUp/);
    expect(background).toContain("if (extensionResetInProgress || Date.now() < suppressBackgroundStorageEventsUntil) return;");
    expect(background).toContain("bestEffortTasks.size");
    expect(background).toContain("await initializeEnabledBackgroundServices().catch(() => undefined);");
    expect(background.indexOf("await initializeEnabledBackgroundServices().catch(() => undefined);")).toBeGreaterThan(
      background.indexOf("await resetExtensionData({")
    );
  });

  test("keeps activation execution in the service worker and only retries pre-write access failures", () => {
    expect(background).toContain("runDurableRequestOperation");
    expect(background).toContain("executeWithPortalAccessRecovery");
    expect(background).toContain("result.accessRecoveryTarget");
    expect(background).toContain("getFreshAccessRecoveryTargets");
    expect(background).toContain("getPortalRecoveryTokenSignature");
    expect(background).toContain("focusPortalRecoveryTabs");
    expect(background).toContain("Check Microsoft PIM before retrying to avoid a duplicate request");
    expect(background).not.toContain("catch (error) {\n        return await activateItems");
  });

  test("keeps popup submission locked while a timed-out request continues in the background", () => {
    expect(popup).toContain("let requestContinuesInBackground = false");
    expect(popup).toContain("requestContinuesInBackground = true");
    expect(popup).toContain("if (!requestContinuesInBackground) {");
  });

  test("keeps portal-recovery polling serialized and preserves the last known state on transient failures", () => {
    expect(popup).toContain("readPortalRecoveryStatus(recoveryStatus)");
    expect(popup).toContain("readPortalRecoveryStatus(progressiveRecoveryStatus)");
    expect(popup).toContain("readPortalRecoveryStatus(portalRecoveryStatusRef.current)");
    expect(popup).not.toContain("setInterval(() => void pollRecovery()");
    expect(settings).toContain("readPortalRecoveryStatus(portalRecoveryStatusRef.current)");
    expect(settings).toContain("readPortalRecoveryStatus(latestRecoveryStatus)");
    expect(settings).not.toContain("setInterval(() => void updateStatus()");
  });

  test("accepts background API verification as portal recovery completion without requiring new token bytes", () => {
    expect(popup).toContain("recoveryStatusObserved && recoveryStatus.state === \"idle\"");
    expect(popup).toContain("if (!recovered.recoveryCompleted)");
    expect(popup).not.toContain("recovered.changedTargets.length !== portalTokenRecoveryTargets.length");
  });

  test("keeps portal recovery owned by the service worker until current-generation API verification", () => {
    expect(background).toContain("initializePortalRecoveryLifecycle()");
    expect(background).toContain("PORTAL_RECOVERY_VERIFY_ALARM_NAME");
    expect(background).toContain("getApiVerifiedPortalRecoveryTargets");
    expect(background).toContain("expectedJourneyCreatedAt");
    expect(background).toContain("schedulePortalRecoveryVerification()");
    expect(background).toContain("schedulePortalRecoveryVerificationTimer");
    expect(background).toContain("closeOrphanedPortalRecoveryTabs(apis)");
    expect(background).not.toContain("closeCompletedRecoveryTabs");
    expect(background).not.toContain("closeCompletedPortalRecoveryTabs");
    expect(background).not.toMatch(/if \(stored\) \{\s*await closePortalRecoveryTabsForTargets/);
  });

  test("generation-guards cleanup requested by popup and Settings refreshes", () => {
    expect(popup).toContain("expectedJourneyCreatedAt: portalRecoveryJourneyCreatedAt");
    expect(settings).toContain("expectedJourneyCreatedAt: options.expectedPortalRecoveryJourneyCreatedAt");
    expect(background).toContain("message.expectedJourneyCreatedAt");
    expect(popup).not.toContain('{ action: "closePortalRecoveryTabs", targets: completedRecoveryTargets }');
    expect(settings).not.toContain('{ action: "closePortalRecoveryTabs", targets: completedRecoveryTargets }');
  });

  test("schedules recovery cleanup even when opening or grouping throws", () => {
    expect(background).toContain("async function openManagedPortalRecoveryTabs");
    expect(background).toContain("return await openPortalRecoveryTabsAndReconcile");
    expect(background).toContain("} finally {");
    expect(background).toContain("Schedule unconditionally");
    expect(background).toContain("schedulePortalRecoveryCleanup()");
    expect(background).toContain("schedulePortalRecoveryVerification()");
  });

  test("re-arms one-shot recovery cleanup after transient browser API failures", () => {
    expect(background).toContain("const PORTAL_RECOVERY_CLEANUP_RETRY_MS = 60_000");
    expect(background).toContain("schedulePortalRecoveryCleanup(PORTAL_RECOVERY_CLEANUP_RETRY_MS)");
    expect(background).toContain("schedulePortalRecoveryVerification(PORTAL_RECOVERY_VERIFY_RETRY_MS)");
  });

  test("releases the manual refresh lock even when a newer refresh supersedes its run", () => {
    expect(popup).toContain("manualRefreshRunId.current = runId");
    expect(popup).toContain("if (manualRefreshRunId.current === runId)");
    expect(popup).not.toContain("manualRefreshInFlight");
  });

  test("retries token-state reads within the existing timeout budget before using verified in-memory state", () => {
    expect(popup).toContain("readTokenStatusWithRetry(tokenStatusRef.current)");
    expect(settings).toContain("readTokenStatusWithRetry(tokenStatusRef.current)");
    expect(popup).toContain("const TOKEN_STATUS_ATTEMPT_TIMEOUT_MS = TOKEN_STATUS_TIMEOUT_MS / 2");
    expect(settings).toContain("const TOKEN_STATUS_ATTEMPT_TIMEOUT_MS = TOKEN_STATUS_TIMEOUT_MS / 2");
  });

  test("queues notification extensions in the service worker without replaying ambiguous writes", () => {
    expect(background).toContain("registerNotificationListeners();");
    expect(background).toContain("chrome.notifications.onButtonClicked?.addListener(trackedNotificationButtonClicked)");
    expect(background).toContain("buildTrackedRequestExtensionPlan");
    expect(background).toContain("continuationOfRequestId: source.requestId");
    expect(background).toContain('extensionAttemptState: "uncertain"');
    expect(background).toContain("check Microsoft PIM before retrying");
  });

  test("reconciles optional notification permission changes and catches up missed expiry reminders", () => {
    expect(background).toContain("chrome.permissions?.onAdded?.addListener(notificationPermissionAdded)");
    expect(background).toContain("chrome.permissions?.onRemoved?.addListener(notificationPermissionRemoved)");
    expect(background).toContain("registerNotificationListeners();");
    expect(background).toContain("expiryReminderAttemptedAt: undefined");
    expect(background).toContain("getTrackedExpiryReminderDecision(request, reminderMinutes, now)");
    expect(background).toContain("showMissedExpiryReminderNotification(request)");
    expect(settings).toContain("Enable on this browser");
    expect(settings).toContain("Send test notification");
    expect(settings).toContain("NOTIFICATION_TEST_BUTTON_TITLES.map");
    expect(settings).toContain('sendRuntimeMessage({ action: "initializeNotificationDelivery" })');
    expect(settings).toContain("buttonEvent.addListener(handleTestButtonClick)");
    expect(background).toContain("notificationId === NOTIFICATION_TEST_ID");
    expect(background).toContain("getNotificationTestButtonResult(buttonIndex)");
  });

  test("coalesces automatic Browser Sync writes and recognizes Edge byte-capacity quotas", () => {
    expect(background).toContain("const BROWSER_SYNC_LOCAL_CHANGE_DEBOUNCE_MS = 30_000");
    expect(background).toContain("const BROWSER_SYNC_REMOTE_CHANGE_DEBOUNCE_MS = 2_000");
    expect(background).toContain("write quota|storage capacity");
  });
});
