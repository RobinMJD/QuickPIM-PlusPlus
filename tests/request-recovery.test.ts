import { describe, expect, test } from "vitest";
import {
  getAccessRecoveryTargets,
  mergeRetriedActivationResponse,
  replaceAccessRecoveryErrors
} from "../src/lib/requestRecovery";
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

  test("keeps recovery metadata when user interaction is still required", () => {
    const replaced = replaceAccessRecoveryErrors(initialResponse, "Finish Microsoft sign-in and retry.");

    expect(replaced.results[0].success).toBe(true);
    expect(replaced.errors).toHaveLength(2);
    expect(replaced.errors.every((result) => result.error === "Finish Microsoft sign-in and retry.")).toBe(true);
    expect(replaced.errors.map((result) => result.accessRecoveryTarget)).toEqual(["pimGroup", "azureRole"]);
  });
});
