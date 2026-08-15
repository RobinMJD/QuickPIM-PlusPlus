import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  getStorePackagePath,
  getStorePackagePaths,
  packageStores,
  STORE_PACKAGE_SUFFIX,
  verifyStorePackage
} from "../scripts/package-stores.mjs";

describe("shared Chromium Store packaging", () => {
  test("uses one neutral package for Chrome and Edge", () => {
    const version = "9.8.7";
    const path = getStorePackagePath(version, "release");
    const paths = getStorePackagePaths(version, "release");
    expect(path).toMatch(/quickpim-plusplus-v9\.8\.7-chromium-stores\.zip$/);
    expect(paths).toEqual({ shared: path, chrome: path, edge: path });
    expect(STORE_PACKAGE_SUFFIX).toBe("chromium-stores");
  });

  test("writes one archive and removes same-version legacy duplicates", () => {
    const version = "9.8.7";
    const root = mkdtempSync(join(tmpdir(), "quickpim-store-package-"));
    const distDir = join(root, "dist");
    const releaseDir = join(root, "release");
    mkdirSync(distDir);
    mkdirSync(releaseDir);
    writeFileSync(join(distDir, "manifest.json"), JSON.stringify({ manifest_version: 3, version }));
    writeFileSync(join(distDir, "popup.html"), "<!doctype html>");
    const legacyChrome = join(releaseDir, `quickpim-plusplus-v${version}-chrome-webstore.zip`);
    const legacyEdge = join(releaseDir, `quickpim-plusplus-v${version}-edge-addons.zip`);
    writeFileSync(legacyChrome, "stale");
    writeFileSync(legacyEdge, "stale");

    try {
      const paths = packageStores({ distDir, releaseDir, version });
      expect(readdirSync(releaseDir)).toEqual([`quickpim-plusplus-v${version}-chromium-stores.zip`]);
      expect(existsSync(paths.shared)).toBe(true);
      expect(paths.chrome).toBe(paths.shared);
      expect(paths.edge).toBe(paths.shared);
      expect(existsSync(legacyChrome)).toBe(false);
      expect(existsSync(legacyEdge)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects missing manifest references and debug artifacts", () => {
    const version = "9.8.7";
    const root = mkdtempSync(join(tmpdir(), "quickpim-store-invalid-"));
    const distDir = join(root, "dist");
    const releaseDir = join(root, "release");
    mkdirSync(distDir);
    writeFileSync(join(distDir, "manifest.json"), JSON.stringify({
      manifest_version: 3,
      version,
      action: { default_popup: "missing-popup.html" }
    }));
    writeFileSync(join(distDir, "background.js.map"), "{}");
    try {
      expect(() => packageStores({ distDir, releaseDir, version })).toThrow(/unsafe or unwanted entry/i);
      rmSync(join(distDir, "background.js.map"));
      expect(() => packageStores({ distDir, releaseDir, version })).toThrow(/missing manifest-referenced file/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("produces identical bytes for unchanged built files", () => {
    const version = "9.8.7";
    const root = mkdtempSync(join(tmpdir(), "quickpim-store-reproducible-"));
    const distDir = join(root, "dist");
    const releaseDir = join(root, "release");
    mkdirSync(distDir);
    writeFileSync(join(distDir, "manifest.json"), JSON.stringify({ manifest_version: 3, version }));
    writeFileSync(join(distDir, "popup.html"), "<!doctype html>");
    try {
      const first = readFileSync(packageStores({ distDir, releaseDir, version }).shared);
      const second = readFileSync(packageStores({ distDir, releaseDir, version }).shared);
      expect(second.equals(first)).toBe(true);
      expect(() => verifyStorePackage(join(releaseDir, "missing.zip"), version)).toThrow(/not found/i);
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
