import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { extname, posix, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { assertEdgeCompatibility } from "./check-edge-compatibility.mjs";

export const STORE_PACKAGE_SUFFIX = "chromium-stores";
const LEGACY_STORE_PACKAGE_SUFFIXES = Object.freeze(["chrome-webstore", "edge-addons"]);
const ALLOWED_PACKAGE_EXTENSIONS = new Set([".css", ".html", ".ico", ".js", ".json", ".png", ".svg", ".webp", ".woff", ".woff2"]);
const FORBIDDEN_PACKAGE_SEGMENTS = new Set(["node_modules", "playwright-report", "test-results", "tests"]);

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
    (entry) =>
      entry.startsWith("/") ||
      entry.split("/").includes("..") ||
      entry.split("/").some((segment) => FORBIDDEN_PACKAGE_SEGMENTS.has(segment)) ||
      /(^|\/)\.(?:DS_Store|git|gitignore|env)/i.test(entry) ||
      /\.map$/i.test(entry) ||
      (!entry.endsWith("/") && !ALLOWED_PACKAGE_EXTENSIONS.has(extname(entry).toLowerCase()))
  );
  if (unsafeEntry) {
    throw new Error(`Store package contains an unsafe or unwanted entry: ${unsafeEntry}`);
  }
  const manifest = JSON.parse(execFileSync("unzip", ["-p", zipPath, "manifest.json"], { encoding: "utf8" }));
  if (manifest.version !== expectedVersion) {
    throw new Error(`Store package version ${manifest.version || "missing"} does not match ${expectedVersion}.`);
  }
  verifyManifestReferences(entries, manifest);
  verifyHtmlReferences(zipPath, entries);
  return { entries, manifest };
}

function verifyManifestReferences(entries, manifest) {
  const required = new Set();
  const add = (value) => {
    if (typeof value === "string" && value && !/[?*]/.test(value)) required.add(normalizeEntry(value));
  };
  const addIconMap = (icons) => Object.values(icons || {}).forEach(add);
  add(manifest?.action?.default_popup);
  addIconMap(manifest?.action?.default_icon);
  addIconMap(manifest?.icons);
  add(manifest?.options_ui?.page);
  add(manifest?.background?.service_worker);
  for (const script of manifest?.content_scripts || []) {
    (script?.js || []).forEach(add);
    (script?.css || []).forEach(add);
  }
  for (const declaration of manifest?.web_accessible_resources || []) {
    (declaration?.resources || []).forEach(add);
  }
  for (const entry of required) {
    if (!entries.includes(entry)) throw new Error(`Store package is missing manifest-referenced file: ${entry}`);
  }
}

function verifyHtmlReferences(zipPath, entries) {
  for (const htmlEntry of entries.filter((entry) => entry.endsWith(".html"))) {
    const html = execFileSync("unzip", ["-p", zipPath, htmlEntry], { encoding: "utf8" });
    for (const match of html.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
      const reference = match[1].split(/[?#]/, 1)[0];
      if (!reference || /^(?:[a-z]+:|#|\/\/)/i.test(reference)) continue;
      const resolved = reference.startsWith("/")
        ? normalizeEntry(reference)
        : normalizeEntry(posix.join(posix.dirname(htmlEntry), reference));
      if (!entries.includes(resolved)) {
        throw new Error(`Store package HTML ${htmlEntry} references missing file: ${resolved}`);
      }
    }
  }
}

function normalizeEntry(value) {
  return posix.normalize(String(value).replaceAll("\\", "/")).replace(/^\.\//, "").replace(/^\/+/, "");
}

function collectPackageFiles(root, current = root) {
  return readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    const absolute = resolve(current, entry.name);
    if (entry.isDirectory()) return collectPackageFiles(root, absolute);
    return [relative(root, absolute).split(sep).join("/")];
  });
}

function getPackageTimestamp() {
  const sourceDateEpoch = Number(process.env.SOURCE_DATE_EPOCH);
  if (Number.isInteger(sourceDateEpoch) && sourceDateEpoch >= 0) return sourceDateEpoch * 1_000;
  try {
    const commitEpoch = Number(execFileSync("git", ["log", "-1", "--format=%ct"], { encoding: "utf8" }).trim());
    if (Number.isInteger(commitEpoch) && commitEpoch >= 0) return commitEpoch * 1_000;
  } catch {
    // Source archives without Git metadata use the Unix epoch.
  }
  return 0;
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

  const files = collectPackageFiles(distPath).sort();
  if (!files.length) throw new Error(`Built extension directory is empty: ${distPath}`);
  const packageTimestamp = new Date(getPackageTimestamp());
  files.forEach((file) => utimesSync(resolve(distPath, file), packageTimestamp, packageTimestamp));
  execFileSync("zip", ["-X", "-q", paths.shared, "-@"], {
    cwd: distPath,
    input: `${files.join("\n")}\n`,
    stdio: ["pipe", "inherit", "inherit"]
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
