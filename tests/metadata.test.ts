import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
const packageLockJson = JSON.parse(readFileSync(resolve("package-lock.json"), "utf8"));
const manifest = JSON.parse(readFileSync(resolve("public/manifest.json"), "utf8"));

describe("versioning and extension manifest", () => {
  test("uses QuickPIM++ for the app name and a plus-safe package identifier", () => {
    expect(manifest.name).toBe("QuickPIM++");
    expect(packageJson.name).toBe("quickpim-plusplus");
    expect(packageLockJson.name).toBe("quickpim-plusplus");
    expect(packageLockJson.packages[""].name).toBe("quickpim-plusplus");
  });

  test("keeps package, lockfile, and manifest versions in sync at v2.0.0", () => {
    expect(packageJson.version).toBe("2.0.0");
    expect(packageLockJson.packages[""].version).toBe("2.0.0");
    expect(packageLockJson.version).toBe("2.0.0");
    expect(manifest.version).toBe("2.0.0");
  });

  test("uses only required host permissions and an explicit extension CSP", () => {
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
    expect(readme).toContain("v2.0.0");
    expect(securityReview).toContain("Threat Model");
    expect(securityReview).toContain("Token Handling");
    expect(license).toContain("MIT License");
    expect(license).toContain("Daniel Bradley and QuickPIM++ contributors");
  });
});
