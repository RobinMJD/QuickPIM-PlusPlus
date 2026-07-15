import { describe, expect, test } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { APP_NAME, APP_VERSION } from "../src/lib/appMetadata";

const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
const packageLockJson = JSON.parse(readFileSync(resolve("package-lock.json"), "utf8"));
const manifest = JSON.parse(readFileSync(resolve("public/manifest.json"), "utf8"));

describe("versioning and extension manifest", () => {
  test("uses QuickPIM++ for the app name and a plus-safe package identifier", () => {
    expect(manifest.name).toBe(APP_NAME);
    expect(packageJson.name).toBe("quickpim-plusplus");
    expect(packageLockJson.name).toBe("quickpim-plusplus");
    expect(packageLockJson.packages[""].name).toBe("quickpim-plusplus");
  });

  test("keeps package, lockfile, and manifest versions in sync at v2.10.11", () => {
    expect(packageJson.version).toBe(APP_VERSION);
    expect(packageLockJson.packages[""].version).toBe(APP_VERSION);
    expect(packageLockJson.version).toBe(APP_VERSION);
    expect(manifest.version).toBe(APP_VERSION);
  });

  test("uses only required host permissions and an explicit extension CSP", () => {
    expect(manifest.permissions).toEqual(["storage", "webRequest", "alarms", "tabGroups"]);
    expect(manifest.optional_permissions).toEqual(["notifications"]);
    expect(manifest.minimum_chrome_version).toBe("102");
    expect(manifest.host_permissions).toEqual([
      "https://graph.microsoft.com/*",
      "https://management.azure.com/*",
      "https://entra.microsoft.com/*",
      "https://api.github.com/*"
    ]);
    expect(manifest.content_scripts).toEqual([
      {
        matches: ["https://entra.microsoft.com/*"],
        js: ["portalTokenCollector.js"],
        run_at: "document_idle",
        all_frames: true
      }
    ]);
    expect(manifest.content_security_policy?.extension_pages).toContain("script-src 'self'");
    expect(manifest.content_security_policy?.extension_pages).toContain("object-src 'none'");
    expect(manifest.content_security_policy?.extension_pages).toContain("connect-src 'self'");
    expect(manifest.content_security_policy?.extension_pages).toContain("https://api.github.com");
    expect(manifest.content_security_policy?.extension_pages).toContain("default-src 'self'");
    expect(manifest.content_security_policy?.extension_pages).toContain("style-src 'self'");
    expect(manifest.content_security_policy?.extension_pages).toContain("img-src 'self' data:");
    expect(manifest.content_security_policy?.extension_pages).toContain("frame-src 'none'");
    expect(manifest.content_security_policy?.extension_pages).toContain("form-action 'none'");
    const popupSource = readFileSync(resolve("src/popup/main.tsx"), "utf8");
    expect(popupSource).not.toContain("style={{");
    expect(popupSource).not.toContain("refreshTrackedRequests");
    expect(popupSource).not.toContain("requestTracking");
  });

  test("keeps build-only tooling out of production dependencies", () => {
    expect(packageJson.dependencies).toEqual({
      react: packageJson.dependencies.react,
      "react-dom": packageJson.dependencies["react-dom"]
    });
    expect(packageJson.devDependencies).toHaveProperty("vite");
    expect(packageJson.devDependencies).toHaveProperty("typescript");
    expect(packageJson.devDependencies).not.toHaveProperty("@testing-library/react");
  });

  test("documents the security review and original author credit", () => {
    const readme = readFileSync(resolve("README.md"), "utf8");
    const securityReview = readFileSync(resolve("SECURITY_REVIEW.md"), "utf8");
    const license = readFileSync(resolve("LICENSE"), "utf8");

    expect(readme).toContain("Original author: Daniel Bradley");
    expect(readme).toContain("v2.10.11");
    expect(securityReview).toContain("Threat Model");
    expect(securityReview).toContain("Token Handling");
    expect(license).toContain("MIT License");
    expect(license).toContain("Daniel Bradley and QuickPIM++ contributors");
  });

  test("references existing README images", () => {
    const readme = readFileSync(resolve("README.md"), "utf8");
    const imagePaths = [...readme.matchAll(/!\[[^\]]+\]\((docs\/images\/[^)]+)\)/g)].map((match) => match[1]);

    expect(imagePaths.length).toBeGreaterThan(0);
    for (const imagePath of imagePaths) {
      expect(existsSync(resolve(imagePath))).toBe(true);
    }
  });
});
