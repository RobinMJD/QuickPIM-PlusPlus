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
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/\bchrome\s*(?:\.\s*([A-Za-z][A-Za-z0-9_]*)|\[\s*["']([^"']+)["']\s*\])/g)) {
      names.add(match[1] || match[2]);
    }
    for (const match of source.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*chrome\s*;/g)) {
      const alias = match[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const aliasPattern = new RegExp(`\\b${alias}\\s*(?:\\.\\s*([A-Za-z][A-Za-z0-9_]*)|\\[\\s*["']([^"']+)["']\\s*\\])`, "g");
      for (const aliasMatch of source.matchAll(aliasPattern)) names.add(aliasMatch[1] || aliasMatch[2]);
    }
    for (const match of source.matchAll(/\b(?:const|let|var)\s*\{([^}]+)\}\s*=\s*chrome\s*;/g)) {
      for (const binding of match[1].split(",")) {
        const api = binding.trim().match(/^([A-Za-z][A-Za-z0-9_]*)/)?.[1];
        if (api) names.add(api);
      }
    }
    if (/\bchrome\s*\[(?!\s*["'])/.test(source)) {
      names.add("<dynamic>");
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
