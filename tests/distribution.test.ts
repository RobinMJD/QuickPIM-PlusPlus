import { describe, expect, test } from "vitest";
import {
  CHROME_WEB_STORE_EXTENSION_ID,
  EDGE_ADDONS_EXTENSION_ID,
  classifyExtensionDistribution,
  detectBrowserFamily
} from "../src/lib/distribution";

describe("browser and Store distribution guard", () => {
  test("detects Microsoft Edge from client hints or its user-agent token", () => {
    expect(detectBrowserFamily("Mozilla/5.0 Chrome/140.0 Safari/537.36 Edg/140.0")).toBe("edge");
    expect(detectBrowserFamily("Mozilla/5.0 Chrome/140.0", [{ brand: "Microsoft Edge" }])).toBe("edge");
  });

  test("blocks only a confirmed Chrome Web Store install running in Edge", () => {
    expect(classifyExtensionDistribution({
      userAgent: "Mozilla/5.0 Chrome/140.0 Safari/537.36 Edg/140.0",
      extensionId: CHROME_WEB_STORE_EXTENSION_ID,
      installType: "normal"
    })).toMatchObject({ browser: "edge", distribution: "chromeWebStore", blockedInEdge: true });

    expect(classifyExtensionDistribution({
      userAgent: "Mozilla/5.0 Chrome/140.0 Safari/537.36 Edg/140.0",
      extensionId: EDGE_ADDONS_EXTENSION_ID,
      installType: "normal"
    })).toMatchObject({ browser: "edge", distribution: "edgeAddons", blockedInEdge: false });
  });

  test("keeps local, managed, and unknown installations usable", () => {
    for (const installType of ["development", "admin"] as const) {
      expect(classifyExtensionDistribution({
        userAgent: "Mozilla/5.0 Chrome/140.0 Safari/537.36 Edg/140.0",
        extensionId: "unlisted-id",
        installType
      }).blockedInEdge).toBe(false);
    }
    expect(classifyExtensionDistribution({
      userAgent: "Mozilla/5.0 Chrome/140.0 Safari/537.36",
      extensionId: CHROME_WEB_STORE_EXTENSION_ID
    }).blockedInEdge).toBe(false);
  });
});
