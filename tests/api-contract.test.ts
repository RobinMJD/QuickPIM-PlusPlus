import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

describe("Microsoft PIM API contracts", () => {
  const background = readFileSync("src/background.ts", "utf8");

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

  test("keeps Azure roles from successful subscriptions when another subscription fails", () => {
    expect(background).toContain("assertAtLeastOneSubscriptionSucceeded");
    expect(background).toContain('results.every((result) => result.status === "rejected")');
    expect(background).not.toContain("assertAllSubscriptionsSucceeded");
  });

  test("tracks submitted requests with bounded Microsoft status checks", () => {
    expect(background).toContain("persistTrackedSubmissionsBestEffort");
    expect(background).toContain("roleAssignmentScheduleRequests/filterByCurrentUser(on='principal')");
    expect(background).toContain("privilegedAccess/group/assignmentScheduleRequests?");
    expect(background).toContain("REQUEST_TRACKING_AZURE_CONCURRENCY");
    expect(background).toContain("REQUEST_TRACKING_GRAPH_CONCURRENCY");
    expect(background).not.toContain("void initializeBackgroundRefresh();\nvoid initializeRequestTracking();");
    expect(background).not.toContain("chrome.cookies");
  });
});
