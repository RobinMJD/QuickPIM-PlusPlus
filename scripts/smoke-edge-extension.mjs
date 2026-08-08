import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";

export async function smokeEdgeExtension(extensionDir = "dist") {
  const extensionPath = resolve(extensionDir);
  if (!existsSync(resolve(extensionPath, "manifest.json"))) {
    throw new Error(`Built extension manifest not found in ${extensionPath}. Run npm run build first.`);
  }
  const context = await chromium.launchPersistentContext("", {
    channel: "msedge",
    headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });
  try {
    let worker = context.serviceWorkers()[0];
    if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 10_000 });
    const extensionId = new URL(worker.url()).host;
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    const title = (await page.locator("h1").first().textContent())?.trim();
    if (title !== "QuickPIM++") {
      throw new Error(`Microsoft Edge loaded an unexpected popup title: ${title || "missing"}.`);
    }
    return { extensionId, title };
  } finally {
    await context.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await smokeEdgeExtension();
    console.log(`Microsoft Edge sideload smoke passed: ${result.title}.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
