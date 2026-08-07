import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  buildEdgeAddonsEndpoints,
  extractEdgeOperationId,
  getEdgeOperationStatus,
  getMissingEdgeAddonsConfig,
  sanitizeEdgeAddonsMessage
} from "../scripts/publish-edge-addons.mjs";

describe("Microsoft Edge Add-ons publisher", () => {
  test("reports missing credentials without exposing configured values", () => {
    expect(
      getMissingEdgeAddonsConfig({
        EDGE_ADDONS_CLIENT_ID: "client",
        EDGE_ADDONS_API_KEY: "",
        EDGE_ADDONS_PRODUCT_ID: "product",
        EDGE_ADDONS_ZIP: ""
      })
    ).toEqual(["EDGE_ADDONS_API_KEY", "EDGE_ADDONS_ZIP"]);
  });

  test("builds encoded v1 package and submission operation endpoints", () => {
    const endpoints = buildEdgeAddonsEndpoints("product/with space");
    expect(endpoints.uploadUrl).toBe(
      "https://api.addons.microsoftedge.microsoft.com/v1/products/product%2Fwith%20space/submissions/draft/package"
    );
    expect(endpoints.uploadStatusUrl("operation/1")).toContain("operations/operation%2F1");
    expect(endpoints.publishUrl).toMatch(/\/submissions$/);
    expect(endpoints.publishStatusUrl("operation/2")).toContain("submissions/operations/operation%2F2");
  });

  test("extracts operation IDs and classifies statuses", () => {
    expect(extractEdgeOperationId("https://example.test/operations/operation-1/")).toBe("operation-1");
    expect(extractEdgeOperationId("operation-2")).toBe("operation-2");
    expect(getEdgeOperationStatus({ status: "InProgress" })).toBe("inprogress");
    expect(getEdgeOperationStatus({ status: "Succeeded" })).toBe("succeeded");
  });

  test("redacts API keys and token-like error content", () => {
    const message = sanitizeEdgeAddonsMessage(
      'Authorization: ApiKey secret-value api_key=other-secret {"access_token":"token-value"}'
    );
    expect(message).not.toContain("secret-value");
    expect(message).not.toContain("other-secret");
    expect(message).not.toContain("token-value");
  });

  test("release workflow deploys Edge updates from the Edge package", () => {
    const workflow = readFileSync(".github/workflows/release.yml", "utf8");
    expect(workflow).toContain("Publish to Microsoft Edge Add-ons");
    expect(workflow).toContain("environment: microsoft-edge-add-ons");
    expect(workflow).toContain("scripts/publish-edge-addons.mjs");
    expect(workflow).toContain("EDGE_ADDONS_CLIENT_ID");
    expect(workflow).toContain("EDGE_ADDONS_API_KEY");
    expect(workflow).toContain("EDGE_ADDONS_PRODUCT_ID");
    expect(workflow).toContain(
      "EDGE_ADDONS_MANUAL_SUBMISSION_TAG != (github.event_name == 'workflow_dispatch' && inputs.tag || github.ref_name)"
    );
    expect(workflow).not.toContain("EDGE_ADDONS_MANUAL_SUBMISSION_TAG != env.RELEASE_TAG");
    expect(workflow).toContain("quickpim-plusplus-${{ env.RELEASE_TAG }}-edge-addons.zip");
  });
});
