import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

describe("Microsoft PIM API contracts", () => {
  const background = readFileSync("src/background.ts", "utf8");
  const popup = readFileSync("src/popup/main.tsx", "utf8");

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
    expect(background).toContain("browserSyncFollowUpRequested = true");
    expect(background).toContain("BROWSER_SYNC_TRANSIENT_RETRY_MINUTES");
    expect(background).toContain("isTransientBrowserSyncError(status.lastError)");
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

  test("queues notification extensions in the service worker without replaying ambiguous writes", () => {
    expect(background).toContain("chrome.notifications?.onButtonClicked");
    expect(background).toContain("buildTrackedRequestExtensionPlan");
    expect(background).toContain("continuationOfRequestId: source.requestId");
    expect(background).toContain('extensionAttemptState: "uncertain"');
    expect(background).toContain("check Microsoft PIM before retrying");
  });
});
