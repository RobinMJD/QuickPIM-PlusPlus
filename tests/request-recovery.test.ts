import { describe, expect, test } from "vitest";
import {
  getAccessRecoveryTargets,
  getClaimsChallengeRecoveryTargets,
  getFreshAccessRecoveryTargets,
  getPortalRecoveryFailureMessage,
  mergeRetriedActivationResponse,
  replaceAccessRecoveryErrors,
  shouldFocusPortalRecovery
} from "../src/lib/requestRecovery";
import { CLAIMS_CHALLENGE_MESSAGE } from "../src/lib/apiErrors";
import type { ActivationResponse } from "../src/lib/types";

describe("activation portal access recovery", () => {
  const initialResponse: ActivationResponse = {
    success: false,
    results: [
      { itemId: "role-1", itemName: "Reader", success: true, requestId: "request-1" },
      {
        itemId: "group-1",
        itemName: "Intune operators",
        success: false,
        error: "PIM group activation needs a stronger token.",
        accessRecoveryTarget: "pimGroup"
      },
      {
        itemId: "role-2",
        itemName: "Contributor",
        success: false,
        error: "Azure role activation needs a fresh token.",
        accessRecoveryTarget: "azureRole"
      }
    ],
    errors: []
  };
  initialResponse.errors = initialResponse.results.filter((result) => !result.success);

  test("selects only targets explicitly marked safe for pre-write recovery", () => {
    expect(getAccessRecoveryTargets(initialResponse)).toEqual(["pimGroup", "azureRole"]);
    expect(getAccessRecoveryTargets({
      success: false,
      results: [{ itemId: "role-3", itemName: "Owner", success: false, error: "Request timed out" }],
      errors: [{ itemId: "role-3", itemName: "Owner", success: false, error: "Request timed out" }]
    })).toEqual([]);
  });

  test("requires a newly captured token for every explicit access recovery", () => {
    const response: ActivationResponse = {
      success: false,
      results: [
        {
          itemId: "directory-role-1",
          itemName: "Hybrid Identity Administrator",
          success: false,
          error: CLAIMS_CHALLENGE_MESSAGE,
          accessRecoveryTarget: "directoryRole"
        },
        {
          itemId: "group-1",
          itemName: "Intune operators",
          success: false,
          error: "PIM group activation needs a stronger token.",
          accessRecoveryTarget: "pimGroup"
        }
      ],
      errors: []
    };
    response.errors = response.results;

    expect(getFreshAccessRecoveryTargets(response)).toEqual(["directoryRole", "pimGroup"]);
    expect(getClaimsChallengeRecoveryTargets(response)).toEqual(["directoryRole"]);
  });

  test("replaces only retried item outcomes and preserves earlier successes", () => {
    const merged = mergeRetriedActivationResponse(initialResponse, {
      success: true,
      results: [
        { itemId: "group-1", itemName: "Intune operators", success: true, requestId: "request-2" },
        { itemId: "role-2", itemName: "Contributor", success: true, requestId: "request-3" }
      ],
      errors: []
    });

    expect(merged.success).toBe(true);
    expect(merged.results).toEqual([
      expect.objectContaining({ itemId: "role-1", requestId: "request-1" }),
      expect.objectContaining({ itemId: "group-1", requestId: "request-2", success: true }),
      expect.objectContaining({ itemId: "role-2", requestId: "request-3", success: true })
    ]);
    expect(merged.errors).toEqual([]);
  });

  test("replaces a legacy recovery result with its tenant-scoped retry outcome", () => {
    const initial: ActivationResponse = {
      success: false,
      results: [{
        itemId: "tenant:tenant-one:pimGroup:group-1:member",
        itemName: "Intune operators",
        success: false,
        error: "Refresh required",
        accessRecoveryTarget: "pimGroup"
      }],
      errors: []
    };
    initial.errors = initial.results;

    const merged = mergeRetriedActivationResponse(initial, {
      success: true,
      results: [{
        itemId: "pimGroup:group-1:member",
        itemName: "Intune operators",
        success: true,
        requestId: "request-after-refresh"
      }],
      errors: []
    });

    expect(merged).toMatchObject({
      success: true,
      results: [{ success: true, requestId: "request-after-refresh" }],
      errors: []
    });
  });

  test("keeps recovery metadata when user interaction is still required", () => {
    const replaced = replaceAccessRecoveryErrors(initialResponse, "Finish Microsoft sign-in and retry.");

    expect(replaced.results[0].success).toBe(true);
    expect(replaced.errors).toHaveLength(2);
    expect(replaced.errors.every((result) => result.error === "Finish Microsoft sign-in and retry.")).toBe(true);
    expect(replaced.errors.map((result) => result.accessRecoveryTarget)).toEqual(["pimGroup", "azureRole"]);
  });

  test("foregrounds unresolved recovery only after a short silent grace period", () => {
    expect(shouldFocusPortalRecovery({
      elapsedMs: 11_999,
      interactionRequired: false,
      requiresFreshToken: false,
      focusAttempts: 0
    })).toBe(false);
    expect(shouldFocusPortalRecovery({
      elapsedMs: 12_000,
      interactionRequired: false,
      requiresFreshToken: false,
      focusAttempts: 0
    })).toBe(true);
    expect(shouldFocusPortalRecovery({
      elapsedMs: 500,
      interactionRequired: true,
      requiresFreshToken: false,
      focusAttempts: 0
    })).toBe(true);
    expect(shouldFocusPortalRecovery({
      elapsedMs: 60_000,
      interactionRequired: true,
      requiresFreshToken: true,
      focusAttempts: 2
    })).toBe(false);
  });

  test("preserves the Microsoft claims action instead of replacing it with a generic timeout", () => {
    expect(getPortalRecoveryFailureMessage({
      remainingTargets: ["directoryRole"],
      claimsChallengeTargets: ["directoryRole"],
      interactionRequired: false,
      targetLabel: () => "Entra role"
    })).toBe(CLAIMS_CHALLENGE_MESSAGE);
    expect(getPortalRecoveryFailureMessage({
      remainingTargets: ["directoryRole"],
      claimsChallengeTargets: [],
      interactionRequired: false,
      targetLabel: () => "Entra role"
    })).toContain("could not capture Entra role request access in time");
  });
});
