import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  getStorePackagePath,
  getStorePackagePaths,
  packageStores,
  STORE_PACKAGE_SUFFIX
} from "../scripts/package-stores.mjs";

describe("shared Chromium Store packaging", () => {
  test("uses one neutral package for Chrome and Edge", () => {
    const path = getStorePackagePath("2.13.14", "release");
    const paths = getStorePackagePaths("2.13.14", "release");
    expect(path).toMatch(/quickpim-plusplus-v2\.13\.14-chromium-stores\.zip$/);
    expect(paths).toEqual({ shared: path, chrome: path, edge: path });
    expect(STORE_PACKAGE_SUFFIX).toBe("chromium-stores");
  });

  test("writes one archive and removes same-version legacy duplicates", () => {
    const root = mkdtempSync(join(tmpdir(), "quickpim-store-package-"));
    const distDir = join(root, "dist");
    const releaseDir = join(root, "release");
    mkdirSync(distDir);
    mkdirSync(releaseDir);
    writeFileSync(join(distDir, "manifest.json"), JSON.stringify({ manifest_version: 3, version: "2.13.14" }));
    writeFileSync(join(distDir, "popup.html"), "<!doctype html>");
    const legacyChrome = join(releaseDir, "quickpim-plusplus-v2.13.14-chrome-webstore.zip");
    const legacyEdge = join(releaseDir, "quickpim-plusplus-v2.13.14-edge-addons.zip");
    writeFileSync(legacyChrome, "stale");
    writeFileSync(legacyEdge, "stale");

    try {
      const paths = packageStores({ distDir, releaseDir, version: "2.13.14" });
      expect(readdirSync(releaseDir)).toEqual(["quickpim-plusplus-v2.13.14-chromium-stores.zip"]);
      expect(existsSync(paths.shared)).toBe(true);
      expect(paths.chrome).toBe(paths.shared);
      expect(paths.edge).toBe(paths.shared);
      expect(existsSync(legacyChrome)).toBe(false);
      expect(existsSync(legacyEdge)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("CI and release workflows retain one verified package", () => {
    const ci = readFileSync(".github/workflows/ci.yml", "utf8");
    const release = readFileSync(".github/workflows/release.yml", "utf8");
    for (const workflow of [ci, release]) {
      expect(workflow).toContain("npm run package:stores");
      expect(workflow).toContain("quickpim-plusplus-v*-chromium-stores.zip");
      expect(workflow).not.toContain("quickpim-plusplus-v*-chrome-webstore.zip");
      expect(workflow).not.toContain("quickpim-plusplus-v*-edge-addons.zip");
    }
  });
});
