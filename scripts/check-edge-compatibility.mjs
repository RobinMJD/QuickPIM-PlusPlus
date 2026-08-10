import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Reviewed against Microsoft's Edge extension API support list.
export const EDGE_REVIEWED_EXTENSION_APIS = Object.freeze([
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

function collectSourceFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectSourceFiles(path);
    return [".js", ".mjs", ".ts", ".tsx"].includes(extname(entry.name)) ? [path] : [];
  });
}

export function getUsedChromeApis(sourceDir = "src") {
  const names = new Set();
  for (const file of collectSourceFiles(resolve(sourceDir))) {
    for (const match of readFileSync(file, "utf8").matchAll(/\bchrome\.([A-Za-z][A-Za-z0-9_]*)/g)) {
      names.add(match[1]);
    }
  }
  return [...names].sort();
}

export function getEdgeCompatibilityIssues({ manifest, usedApis = [] }) {
  const issues = [];
  if (manifest?.manifest_version !== 3) {
    issues.push("Microsoft Edge package must use the reviewed Manifest V3 configuration.");
  }
  if (Object.hasOwn(manifest || {}, "update_url")) {
    issues.push("Remove update_url before publishing to Microsoft Edge Add-ons.");
  }
  for (const field of ["name", "short_name", "description"]) {
    if (/\bchrome\b/i.test(String(manifest?.[field] || ""))) {
      issues.push(`Manifest ${field} must not use Chrome branding for Microsoft Edge certification.`);
    }
  }
  const reviewed = new Set(EDGE_REVIEWED_EXTENSION_APIS);
  for (const api of usedApis) {
    if (!reviewed.has(api)) {
      issues.push(`chrome.${api} has not been reviewed for Microsoft Edge compatibility.`);
    }
  }
  return issues;
}

export function assertEdgeCompatibility({ manifestPath = "public/manifest.json", sourceDir = "src" } = {}) {
  const manifest = JSON.parse(readFileSync(resolve(manifestPath), "utf8"));
  const usedApis = getUsedChromeApis(sourceDir);
  const issues = getEdgeCompatibilityIssues({ manifest, usedApis });
  if (issues.length) {
    throw new Error(`Microsoft Edge compatibility check failed:\n- ${issues.join("\n- ")}`);
  }
  return { manifest, usedApis };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = assertEdgeCompatibility();
    console.log(`Microsoft Edge compatibility check passed for: ${result.usedApis.join(", ")}.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
