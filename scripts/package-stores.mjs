import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertEdgeCompatibility } from "./check-edge-compatibility.mjs";

export const STORE_PACKAGE_SUFFIX = "chromium-stores";
const LEGACY_STORE_PACKAGE_SUFFIXES = Object.freeze(["chrome-webstore", "edge-addons"]);

export function getStorePackagePath(version, releaseDir = "release") {
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(String(version || ""))) {
    throw new Error(`Invalid extension version: ${version || "missing"}.`);
  }
  return resolve(releaseDir, `quickpim-plusplus-v${version}-${STORE_PACKAGE_SUFFIX}.zip`);
}

export function getStorePackagePaths(version, releaseDir = "release") {
  const shared = getStorePackagePath(version, releaseDir);
  return Object.freeze({ shared, chrome: shared, edge: shared });
}

export function verifyStorePackage(zipPath, expectedVersion) {
  if (!existsSync(zipPath)) {
    throw new Error(`Store package not found: ${zipPath}`);
  }
  const entries = execFileSync("unzip", ["-Z1", zipPath], { encoding: "utf8" })
    .split(/\r?\n/)
    .filter(Boolean);
  if (!entries.includes("manifest.json")) {
    throw new Error(`Store package is missing manifest.json at its root: ${zipPath}`);
  }
  const unsafeEntry = entries.find(
    (entry) => entry.startsWith("/") || entry.split("/").includes("..") || /(^|\/)\.DS_Store$/.test(entry)
  );
  if (unsafeEntry) {
    throw new Error(`Store package contains an unsafe or unwanted entry: ${unsafeEntry}`);
  }
  const manifest = JSON.parse(execFileSync("unzip", ["-p", zipPath, "manifest.json"], { encoding: "utf8" }));
  if (manifest.version !== expectedVersion) {
    throw new Error(`Store package version ${manifest.version || "missing"} does not match ${expectedVersion}.`);
  }
  return { entries, manifest };
}

export function packageStores({ distDir = "dist", releaseDir = "release", version } = {}) {
  const resolvedVersion = version || JSON.parse(readFileSync("package.json", "utf8")).version;
  const distPath = resolve(distDir);
  if (!existsSync(resolve(distPath, "manifest.json"))) {
    throw new Error(`Built extension manifest not found in ${distPath}. Run npm run build first.`);
  }
  assertEdgeCompatibility({ manifestPath: resolve(distPath, "manifest.json") });
  mkdirSync(releaseDir, { recursive: true });
  const paths = getStorePackagePaths(resolvedVersion, releaseDir);
  const legacyPaths = LEGACY_STORE_PACKAGE_SUFFIXES.map((suffix) =>
    resolve(releaseDir, `quickpim-plusplus-v${resolvedVersion}-${suffix}.zip`)
  );
  for (const path of new Set([paths.shared, ...legacyPaths])) rmSync(path, { force: true });

  execFileSync("zip", ["-X", "-q", "-r", paths.shared, ".", "-x", "*.DS_Store"], {
    cwd: distPath,
    stdio: "inherit"
  });

  verifyStorePackage(paths.shared, resolvedVersion);
  console.log(`Verified shared Chromium Store package: ${paths.shared}`);
  return paths;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    packageStores();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
