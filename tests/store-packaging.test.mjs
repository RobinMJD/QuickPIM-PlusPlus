import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { getStorePackagePaths, STORE_PACKAGE_SUFFIXES } from "../scripts/package-stores.mjs";

describe("dual Store packaging", () => {
  test("creates distinct Chrome and Edge package names from one version", () => {
    const paths = getStorePackagePaths("2.11.12", "release");
    expect(paths.chrome).toMatch(/quickpim-plusplus-v2\.11\.12-chrome-webstore\.zip$/);
    expect(paths.edge).toMatch(/quickpim-plusplus-v2\.11\.12-edge-addons\.zip$/);
    expect(STORE_PACKAGE_SUFFIXES).toEqual({ chrome: "chrome-webstore", edge: "edge-addons" });
  });

  test("CI and release workflows retain both verified packages", () => {
    const ci = readFileSync(".github/workflows/ci.yml", "utf8");
    const release = readFileSync(".github/workflows/release.yml", "utf8");
    for (const workflow of [ci, release]) {
      expect(workflow).toContain("npm run package:stores");
      expect(workflow).toContain("quickpim-plusplus-v*-chrome-webstore.zip");
      expect(workflow).toContain("quickpim-plusplus-v*-edge-addons.zip");
    }
  });
});
