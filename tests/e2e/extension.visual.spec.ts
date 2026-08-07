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
  const page = await openExtensionPage("popup.html", { width: 520, height: 600 });
  await seedPopupRole(page);
  await page.reload();

  await expect(page.getByRole("heading", { name: "QuickPIM++" })).toBeVisible();
  const row = page.locator(".role-row.selectable").first();
  await expect(row).toBeVisible();
  await row.focus();
  await page.keyboard.press("Space");
  await expect(page.getByRole("button", { name: /Continue with 1 selected/i })).toBeVisible();

  const geometry = await page.evaluate(() => {
    const content = document.querySelector<HTMLElement>(".content");
    const footer = document.querySelector<HTMLElement>(".activation-bar");
    const quickFilters = document.querySelector<HTMLElement>(".quick-filter-row");
    const shell = document.querySelector<HTMLElement>(".app-shell");
    if (content) content.scrollTop = content.scrollHeight;
    return {
      bodyWidth: document.body.getBoundingClientRect().width,
      documentScrollHeight: document.documentElement.scrollHeight,
      scrollWidth: document.documentElement.scrollWidth,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
      contentClientHeight: content?.clientHeight,
      contentScrollHeight: content?.scrollHeight,
      contentOverflowY: content ? getComputedStyle(content).overflowY : undefined,
      quickFilterClientHeight: quickFilters?.clientHeight,
      quickFilterScrollHeight: quickFilters?.scrollHeight,
      footerBottom: footer?.getBoundingClientRect().bottom,
      shellBottom: shell?.getBoundingClientRect().bottom
    };
  });
  expect(geometry.bodyWidth).toBeLessThanOrEqual(520);
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.viewportWidth);
  expect(geometry.documentScrollHeight).toBeLessThanOrEqual(geometry.viewportHeight);
  expect(geometry.contentOverflowY).toBe("auto");
  expect(geometry.contentScrollHeight).toBeGreaterThan(geometry.contentClientHeight || 0);
  expect(geometry.quickFilterScrollHeight).toBeLessThanOrEqual(geometry.quickFilterClientHeight || 0);
  if (geometry.footerBottom !== undefined) {
    expect(geometry.footerBottom).toBeLessThanOrEqual(geometry.viewportHeight);
    expect(geometry.footerBottom).toBeCloseTo(geometry.shellBottom || geometry.viewportHeight, 0);
  }

  await page.getByRole("button", { name: /Continue with 1 selected/i }).click();
  await expect(page.getByRole("tab", { name: "History" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel", { name: "Justification history" })).toContainText("Recent visual reason");
  await expect(page.getByRole("tabpanel", { name: "Justification history" })).not.toContainText("Saved visual reason");
  await page.getByRole("tab", { name: "Saved" }).click();
  await expect(page.getByRole("tabpanel", { name: "Saved justifications" })).toContainText("Saved visual reason");
  await expect(page.getByRole("tabpanel", { name: "Saved justifications" })).not.toContainText("Recent visual reason");
  await assertNoHorizontalOverflow(page);
  await testInfo.attach("popup-selected", { body: await page.screenshot(), contentType: "image/png" });
  await page.close();
});

test("account details stay within the popup and keep copyable values on one line", async ({}, testInfo) => {
  const page = await openExtensionPage("popup.html", { width: 520, height: 600 });
  await seedPopupIdentity(page);
  await page.reload();

  const accountButton = page.getByLabel("Show Microsoft account details");
  const closedColors = await accountButton.evaluate((element) => ({
    color: getComputedStyle(element).color,
    background: getComputedStyle(element).backgroundColor
  }));
  await accountButton.click();
  const panel = page.locator(".account-popover-panel");
  await expect(panel).toBeVisible();
  const openColors = await accountButton.evaluate((element) => ({
    color: getComputedStyle(element).color,
    background: getComputedStyle(element).backgroundColor
  }));
  expect(openColors).not.toEqual(closedColors);
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
  await page.locator(".brand").click();
  await expect(panel).toBeHidden();
  await testInfo.attach("popup-account-details", { body: await page.screenshot(), contentType: "image/png" });
  await page.close();
});

test("bundle cards stay compact while settings remain pinned at the bottom", async ({}, testInfo) => {
  const page = await openExtensionPage("popup.html", { width: 520, height: 600 });
  await seedPopupRole(page);
  await page.reload();
  await page.getByRole("tab", { name: "Bundles" }).click();

  await expect(page.getByRole("heading", { name: "Visual privileged bundle" })).toBeVisible();
  await expect(page.getByText("Application Administrator with a deliberately long visual regression name", { exact: true })).toBeVisible();
  await expect(page.getByText("2 hours", { exact: true })).toBeVisible();
  await expect(page.getByText("Validate the visual regression environment", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Load selection" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Activate now as-is" })).toBeVisible();

  const geometry = await page.evaluate(() => {
    const shell = document.querySelector<HTMLElement>(".app-shell");
    const bundleList = document.querySelector<HTMLElement>(".bundle-list");
    const card = document.querySelector<HTMLElement>(".bundle-card");
    const footer = document.querySelector<HTMLElement>(".bundle-tab-footer");
    const settingsButton = document.querySelector<HTMLElement>(".bundle-settings-button");
    return {
      listHeight: bundleList?.getBoundingClientRect().height,
      listMaxHeight: bundleList ? getComputedStyle(bundleList).maxHeight : undefined,
      listOverflowY: bundleList ? getComputedStyle(bundleList).overflowY : undefined,
      cardHeight: card?.getBoundingClientRect().height,
      footerBottom: footer?.getBoundingClientRect().bottom,
      shellBottom: shell?.getBoundingClientRect().bottom,
      settingsButtonHeight: settingsButton?.getBoundingClientRect().height
    };
  });
  expect(geometry.listHeight).toBeLessThanOrEqual(390);
  expect(geometry.listMaxHeight).toBe("390px");
  expect(geometry.listOverflowY).toBe("auto");
  expect(geometry.cardHeight).toBeLessThan(250);
  expect(geometry.footerBottom).toBeCloseTo(geometry.shellBottom || 600, 0);
  expect(geometry.settingsButtonHeight).toBeLessThanOrEqual(30);
  await assertNoHorizontalOverflow(page);
  await testInfo.attach("popup-bundles", { body: await page.screenshot(), contentType: "image/png" });
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

test("activity shows useful timestamps and a justification copy action", async ({}, testInfo) => {
  const page = await openExtensionPage("settings.html#activity", { width: 1000, height: 720 });
  await seedActivity(page);
  await page.reload();

  await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible();
  const requestRow = page.getByRole("button", { name: /Exchange Administrator/ }).first();
  await expect(requestRow.locator("time")).toHaveText(/2026-07-20 \d{2}:\d{2}/);
  await requestRow.click();
  await expect(page.getByRole("complementary", { name: /Exchange Administrator request details/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy justification" })).toBeVisible();
  await assertNoHorizontalOverflow(page);
  await testInfo.attach("settings-activity", { body: await page.screenshot(), contentType: "image/png" });
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
    const encode = (value: Record<string, unknown>) => btoa(JSON.stringify(value))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
    const token = `${encode({ alg: "none" })}.${encode({
      aud: "https://graph.microsoft.com",
      exp: Math.floor(Date.now() / 1000) + 3600,
      tid: "tenant-visual",
      oid: "visual-principal",
      preferred_username: "admin@contoso.onmicrosoft.com"
    })}.signature`;
    await chrome.storage.session.set({
      graphToken: token,
      tokenTimestamp: Date.now(),
      tokenSource: "portal"
    });
    const settingsKey = "quickPimSettings.v1";
    const stored = await chrome.storage.local.get(settingsKey);
    const settings = stored[settingsKey] && typeof stored[settingsKey] === "object"
      ? stored[settingsKey] as Record<string, unknown>
      : {};
    const preferences = (settings.preferences || {}) as Record<string, unknown>;
    await chrome.storage.local.set({
      [settingsKey]: {
        ...settings,
        savedJustifications: ["Saved visual reason"],
        recentJustifications: ["Recent visual reason"],
        bundles: [{
          id: "bundle:visual",
          name: "Visual privileged bundle",
          itemIds: ["directoryRole:visual-test-1:/"],
          defaultDurationHours: 2,
          defaultJustification: "Validate the visual regression environment"
        }],
        preferences: {
          ...preferences,
          enabledFeatures: ["directoryRole", "bundles"],
          autoEnabledFeaturesInitialized: true
        }
      }
    });
    const now = Date.now();
    const baseItem = {
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
    const items = Array.from({ length: 14 }, (_, index) => ({
      ...baseItem,
      id: `directoryRole:visual-test-${index + 1}:/`,
      roleDefinitionId: `visual-test-${index + 1}`,
      sourceName: index === 0 ? baseItem.sourceName : `Visual regression role ${index + 1}`,
      displayName: index === 0 ? baseItem.displayName : `Visual regression role ${index + 1}`
    }));
    const cacheKey = "graphDirectory:tenant-visual:visual-principal:";
    const entry = { items, errors: [], fetchedAt: now, cacheKey };
    const empty = { items: [], errors: [], fetchedAt: now, cacheKey };
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

async function seedActivity(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const settingsKey = "quickPimSettings.v1";
    const requestTrackingKey = "quickPimRequests.v1";
    const stored = await chrome.storage.local.get(settingsKey);
    const settings = stored[settingsKey] as Record<string, unknown> | undefined;
    await chrome.storage.local.set({
      ...(settings ? {
        [settingsKey]: {
          ...settings,
          activityHistory: [{
            id: "activity-visual",
            action: "activate",
            result: "success",
            itemId: "directoryRole:exchange:/",
            itemName: "Exchange Administrator",
            itemType: "directoryRole",
            scopeLabel: "Tenant",
            requestedAt: "2026-07-20T08:30:00.000Z",
            completedAt: "2026-07-20T08:31:00.000Z",
            durationHours: 1,
            justification: "Complete the approved Exchange migration change."
          }]
        }
      } : {}),
      [requestTrackingKey]: {
        version: 1,
        requests: [{
          id: "directoryRole:request-visual",
          requestId: "request-visual",
          action: "activate",
          itemId: "directoryRole:exchange:/",
          itemName: "Exchange Administrator",
          itemType: "directoryRole",
          scopeLabel: "Tenant",
          principalId: "principal-visual",
          tenantId: "tenant-visual",
          roleDefinitionId: "role-visual",
          directoryScopeId: "/",
          status: "pendingApproval",
          rawStatus: "PendingApproval",
          requestedAt: "2026-07-20T08:30:00.000Z",
          updatedAt: "2026-07-20T08:31:00.000Z",
          lastCheckedAt: "2026-07-20T08:31:00.000Z",
          durationHours: 1,
          justification: "Complete the approved Exchange migration change.",
          checkCount: 1
        }]
      }
    });
  });
}

async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  const dimensions = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, viewportWidth: window.innerWidth }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.viewportWidth);
}
