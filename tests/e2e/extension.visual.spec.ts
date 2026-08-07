import { chromium, expect, test, type BrowserContext, type Page } from "@playwright/test";
import path from "node:path";

let context: BrowserContext;
let extensionId: string;

test.beforeAll(async () => {
  const extensionPath = path.resolve("dist");
  context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent("serviceworker");
  extensionId = new URL(worker.url()).host;
});

test.afterAll(async () => {
  await context.close();
});

test("popup stays within its fixed viewport and supports a keyboard selection flow", async ({}, testInfo) => {
  const page = await openExtensionPage("popup.html", { width: 520, height: 800 });
  await seedPopupRole(page);
  await page.reload();

  await expect(page.getByRole("heading", { name: "QuickPIM++" })).toBeVisible();
  const row = page.locator(".role-row.selectable").first();
  await expect(row).toBeVisible();
  await row.focus();
  await page.keyboard.press("Space");
  await expect(page.getByRole("button", { name: /Continue with 1 selected/i })).toBeVisible();

  const geometry = await page.evaluate(() => ({
    bodyWidth: document.body.getBoundingClientRect().width,
    scrollWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
    footerBottom: document.querySelector(".activation-bar")?.getBoundingClientRect().bottom
  }));
  expect(geometry.bodyWidth).toBeLessThanOrEqual(520);
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.viewportWidth);
  if (geometry.footerBottom !== undefined) {
    expect(geometry.footerBottom).toBeLessThanOrEqual(800);
    expect(geometry.footerBottom).toBeGreaterThanOrEqual(799);
  }
  await testInfo.attach("popup-selected", { body: await page.screenshot(), contentType: "image/png" });
  await page.close();
});

test("account details stay within the popup and keep copyable values on one line", async ({}, testInfo) => {
  const page = await openExtensionPage("popup.html", { width: 520, height: 800 });
  await seedPopupIdentity(page);
  await page.reload();

  await page.getByLabel("Show Microsoft account details").click();
  const panel = page.locator(".account-popover-panel");
  await expect(panel).toBeVisible();
  await expect(panel.locator(".account-detail-value")).toHaveText([
    "admin@contoso.onmicrosoft.com",
    "tenant-visual"
  ]);
  await expect(panel.locator(".account-copy-button")).toHaveCount(2);

  const geometry = await panel.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const values = [...element.querySelectorAll<HTMLElement>(".account-detail-value")];
    return {
      left: rect.left,
      right: rect.right,
      viewportWidth: window.innerWidth,
      valueWhiteSpace: values.map((value) => getComputedStyle(value).whiteSpace),
      valueFits: values.map((value) => value.scrollWidth <= value.clientWidth)
    };
  });
  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth);
  expect(geometry.valueWhiteSpace).toEqual(["nowrap", "nowrap"]);
  expect(geometry.valueFits).toEqual([true, true]);
  await testInfo.attach("popup-account-details", { body: await page.screenshot(), contentType: "image/png" });
  await page.close();
});

test("settings navigation and diagnostics remain aligned at desktop and compact widths", async ({}, testInfo) => {
  const page = await openExtensionPage("settings.html#diagnostics", { width: 1280, height: 800 });
  await expect(page.getByRole("heading", { name: "Diagnostics" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy report" })).toBeVisible();
  const diagnosticRows = await page.locator(".activity-list .activity-row").allTextContents();
  expect(new Set(diagnosticRows).size).toBe(diagnosticRows.length);
  await assertNoHorizontalOverflow(page);
  await testInfo.attach("settings-desktop", { body: await page.screenshot(), contentType: "image/png" });

  await page.setViewportSize({ width: 720, height: 800 });
  await assertNoHorizontalOverflow(page);
  await expect(page.getByRole("button", { name: "Download JSON" })).toBeVisible();
  await testInfo.attach("settings-compact", { body: await page.screenshot(), contentType: "image/png" });
  await page.close();
});

async function openExtensionPage(route: string, viewport: { width: number; height: number }): Promise<Page> {
  const page = await context.newPage();
  await page.setViewportSize(viewport);
  await page.goto(`chrome-extension://${extensionId}/${route}`);
  return page;
}

async function seedPopupRole(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const settingsKey = "quickPimSettings.v1";
    const stored = await chrome.storage.local.get(settingsKey);
    const settings = stored[settingsKey] as Record<string, unknown> | undefined;
    if (settings && typeof settings === "object") {
      const preferences = (settings.preferences || {}) as Record<string, unknown>;
      await chrome.storage.local.set({
        [settingsKey]: {
          ...settings,
          preferences: {
            ...preferences,
            enabledFeatures: ["directoryRole", "bundles"],
            autoEnabledFeaturesInitialized: true
          }
        }
      });
    }
    const now = Date.now();
    const item = {
      id: "directoryRole:visual-test:/",
      type: "directoryRole",
      sourceName: "Application Administrator with a deliberately long visual regression name",
      displayName: "Application Administrator with a deliberately long visual regression name",
      principalId: "visual-principal",
      roleDefinitionId: "visual-test",
      directoryScopeId: "/",
      scopeLabel: "Tenant",
      status: "eligible",
      activationPolicyState: "ready",
      activationRequirements: { justification: true, ticket: false, approval: false, maxDurationHours: 4 }
    };
    const entry = { items: [item], errors: [], fetchedAt: now, cacheKey: "graphDirectory:missing" };
    const empty = { items: [], errors: [], fetchedAt: now, cacheKey: "graphDirectory:missing" };
    await chrome.storage.local.set({
      "quickPimDataCache.v1": {
        eligibleByTarget: { directoryRole: entry },
        activeByTarget: { directoryRole: empty }
      }
    });
  });
}

async function seedPopupIdentity(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const encode = (value: Record<string, unknown>) => btoa(JSON.stringify(value))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
    const token = `${encode({ alg: "none" })}.${encode({
      aud: "https://graph.microsoft.com",
      exp: Math.floor(Date.now() / 1000) + 3600,
      tid: "tenant-visual",
      oid: "principal-visual",
      preferred_username: "admin@contoso.onmicrosoft.com"
    })}.signature`;
    await chrome.storage.session.set({
      graphToken: token,
      tokenTimestamp: Date.now(),
      tokenSource: "portal"
    });
  });
}

async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  const dimensions = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, viewportWidth: window.innerWidth }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.viewportWidth);
}
