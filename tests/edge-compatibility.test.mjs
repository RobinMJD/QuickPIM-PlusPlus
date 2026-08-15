import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  assertEdgeCompatibility,
  getEdgeCompatibilityIssues,
  getUsedChromeApis
} from "../scripts/check-edge-compatibility.mjs";

describe("Microsoft Edge compatibility gate", () => {
  test("approves the current manifest and reviewed extension APIs", () => {
    const result = assertEdgeCompatibility();
    expect(result.manifest).not.toHaveProperty("update_url");
    expect(result.usedApis).toEqual([
      "action",
      "alarms",
      "management",
      "notifications",
      "permissions",
      "runtime",
      "storage",
      "tabGroups",
      "tabs",
      "webRequest",
      "windows"
    ]);
    expect(getUsedChromeApis()).toEqual(result.usedApis);
  });

  test("rejects Edge porting violations and unreviewed APIs", () => {
    const issues = getEdgeCompatibilityIssues({
      manifest: {
        manifest_version: 2,
        name: "Chrome helper",
        description: "For Chrome",
        update_url: "https://example.test/update.xml"
      },
      usedApis: ["runtime", "identity"]
    });
    expect(issues).toContain("Microsoft Edge package must use the reviewed Manifest V3 configuration.");
    expect(issues).toContain("Remove update_url before publishing to Microsoft Edge Add-ons.");
    expect(issues).toContain("chrome.identity has not been reviewed for Microsoft Edge compatibility.");
    expect(issues.filter((issue) => issue.includes("Chrome branding"))).toHaveLength(2);
  });

  test("detects bracket, alias, destructured, and dynamic API access", () => {
    const root = mkdtempSync(join(tmpdir(), "quickpim-edge-scan-"));
    writeFileSync(join(root, "apis.ts"), `
      chrome["storage"].local;
      const browserApi = chrome;
      browserApi.tabs.query({});
      const { alarms, notifications: notices } = chrome;
      chrome[apiName];
    `);
    try {
      expect(getUsedChromeApis(root)).toEqual(["<dynamic>", "alarms", "notifications", "storage", "tabs"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("CI and release workflows run the compatibility gate", () => {
    for (const workflow of [".github/workflows/ci.yml", ".github/workflows/release.yml"]) {
      expect(readFileSync(workflow, "utf8")).toContain("npm run check:edge");
    }
  });
});
