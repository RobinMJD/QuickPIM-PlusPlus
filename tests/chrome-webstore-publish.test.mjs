import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  buildChromeWebStoreEndpoints,
  getMissingChromeWebStoreConfig,
  getUploadState,
  isUploadFailure,
  isUploadInProgress,
  isUploadSuccess,
  sanitizeChromeWebStoreMessage
} from "../scripts/publish-chrome-webstore.mjs";

describe("Chrome Web Store publish script", () => {
  test("reports missing automation secrets without exposing provided values", () => {
    const missing = getMissingChromeWebStoreConfig({
      CHROME_WEBSTORE_CLIENT_ID: "client-id",
      CHROME_WEBSTORE_CLIENT_SECRET: "",
      CHROME_WEBSTORE_REFRESH_TOKEN: "refresh-token",
      CHROME_WEBSTORE_PUBLISHER_ID: "publisher-id",
      CHROME_WEBSTORE_EXTENSION_ID: "",
      CHROME_WEBSTORE_ZIP: "release/extension.zip"
    });

    expect(missing).toEqual(["CHROME_WEBSTORE_CLIENT_SECRET", "CHROME_WEBSTORE_EXTENSION_ID"]);
  });

  test("builds encoded v2 upload, status, and publish endpoints", () => {
    const endpoints = buildChromeWebStoreEndpoints({
      publisherId: "publisher/with space",
      extensionId: "item/with space"
    });

    expect(endpoints.uploadUrl).toBe(
      "https://chromewebstore.googleapis.com/upload/v2/publishers/publisher%2Fwith%20space/items/item%2Fwith%20space:upload"
    );
    expect(endpoints.fetchStatusUrl).toBe(
      "https://chromewebstore.googleapis.com/v2/publishers/publisher%2Fwith%20space/items/item%2Fwith%20space:fetchStatus"
    );
    expect(endpoints.publishUrl).toBe(
      "https://chromewebstore.googleapis.com/v2/publishers/publisher%2Fwith%20space/items/item%2Fwith%20space:publish"
    );
  });

  test("classifies upload states from top-level and nested API payloads", () => {
    expect(getUploadState({ uploadState: "UPLOAD_IN_PROGRESS" })).toBe("UPLOAD_IN_PROGRESS");
    expect(getUploadState({ item: { uploadState: "SUCCESS" } })).toBe("SUCCESS");
    expect(isUploadInProgress({ uploadState: "UPLOAD_IN_PROGRESS" })).toBe(true);
    expect(isUploadSuccess({ uploadState: "SUCCESS" })).toBe(true);
    expect(isUploadFailure({ uploadState: "FAILURE" })).toBe(true);
  });

  test("redacts token-like text from API messages", () => {
    expect(
      sanitizeChromeWebStoreMessage("Authorization failed for ya29.abc1234567890 and refresh_token=1//secret-value")
    ).toBe("Authorization failed for [redacted] and refresh_token=[redacted]");
  });
});

describe("release workflow Chrome Web Store publishing", () => {
  test("publishes the release ZIP when Chrome Web Store secrets are configured", () => {
    const workflow = readFileSync(".github/workflows/release.yml", "utf8");

    expect(workflow).toContain("Publish to Chrome Web Store");
    expect(workflow).toContain("CHROME_WEBSTORE_CLIENT_ID");
    expect(workflow).toContain("CHROME_WEBSTORE_REFRESH_TOKEN");
    expect(workflow).toContain("scripts/publish-chrome-webstore.mjs");
  });
});
