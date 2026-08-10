import { chromium, expect, test, type BrowserContext, type Page, type Worker } from "@playwright/test";
import path from "node:path";

let context: BrowserContext;
let extensionId: string;
let serviceWorker: Worker;

test.beforeEach(async () => {
  const extensionPath = path.resolve("dist");
  context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });
  serviceWorker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  extensionId = new URL(serviceWorker.url()).host;
});

test.afterEach(async () => {
  await context.close();
});

test("popup stays within its fixed viewport and supports a keyboard selection flow", async ({}, testInfo) => {
  await seedPopupRole(serviceWorker);
  const page = await openExtensionPage("popup.html", { width: 520, height: 600 });

  await expect(page.getByRole("heading", { name: "QuickPIM++" })).toBeVisible();
  const idleFooter = page.locator(".activation-footer-actions");
  const idleFooterHeight = await idleFooter.evaluate((element) => element.getBoundingClientRect().height);
  await expect(idleFooter).toHaveCSS("justify-content", "flex-end");
  const idleSettingsBox = await idleFooter.getByRole("button", { name: "Settings" }).boundingBox();
  expect((idleSettingsBox?.x || 0) + (idleSettingsBox?.width || 0)).toBeGreaterThan(500);
  const row = page.locator(".role-row.selectable").first();
  await expect(row).toBeVisible();
  await row.focus();
  await page.keyboard.press("Space");
  await expect(page.getByRole("button", { name: /Continue with 1 selected/i })).toBeVisible();
  const selectedSettingsBox = await page.locator(".activation-footer-actions").getByRole("button", { name: "Settings" }).boundingBox();
  expect((selectedSettingsBox?.x || 0) + (selectedSettingsBox?.width || 0)).toBeGreaterThan(500);

  const geometry = await page.evaluate(() => {
    const content = document.querySelector<HTMLElement>(".content");
    const footer = document.querySelector<HTMLElement>(".activation-bar");
    const activeFilter = document.querySelector<HTMLElement>(".active-filter-switch");
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
      activeFilterClientHeight: activeFilter?.clientHeight,
      activeFilterScrollHeight: activeFilter?.scrollHeight,
      footerBottom: footer?.getBoundingClientRect().bottom,
      shellBottom: shell?.getBoundingClientRect().bottom
    };
  });
  expect(geometry.bodyWidth).toBeLessThanOrEqual(520);
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.viewportWidth);
  expect(geometry.documentScrollHeight).toBeLessThanOrEqual(geometry.viewportHeight);
  expect(geometry.contentOverflowY).toBe("auto");
  expect(geometry.contentScrollHeight).toBeGreaterThan(geometry.contentClientHeight || 0);
  expect(geometry.activeFilterScrollHeight).toBeLessThanOrEqual(geometry.activeFilterClientHeight || 0);
  if (geometry.footerBottom !== undefined) {
    expect(geometry.footerBottom).toBeLessThanOrEqual(geometry.viewportHeight);
    expect(geometry.footerBottom).toBeCloseTo(geometry.shellBottom || geometry.viewportHeight, 0);
  }

  await page.getByRole("button", { name: /Continue with 1 selected/i }).click();
  const backButton = page.getByRole("button", { name: "Back to role selection" });
  const activateButton = page.getByRole("button", { name: "Activate 1 selected" });
  const saveButton = page.getByRole("button", { name: "Save justification" });
  const justification = page.locator(".justification-textarea");
  await expect(backButton).toBeVisible();
  await expect(saveButton).toHaveClass(/justification-save-overlay/);
  const [backBox, activateBox] = await Promise.all([backButton.boundingBox(), activateButton.boundingBox()]);
  expect(backBox?.x).toBeLessThan(activateBox?.x || 0);
  const reviewActionBoxes = await page.locator(".activation-review-actions .btn").evaluateAll((buttons) =>
    buttons.map((button) => {
      const rect = button.getBoundingClientRect();
      return { top: rect.top, height: rect.height };
    })
  );
  expect(reviewActionBoxes).toHaveLength(4);
  expect(new Set(reviewActionBoxes.map((box) => box.top)).size).toBe(1);
  expect(new Set(reviewActionBoxes.map((box) => box.height)).size).toBe(1);
  await expect(page.locator(".activation-review-actions")).toHaveJSProperty("clientHeight", idleFooterHeight);
  await expect(justification).toHaveCSS("height", "58px");
  await activateButton.click();
  const validationError = page.locator(".dismissible-message").filter({ hasText: "Enter a justification" });
  await expect(validationError).toBeVisible();
  const validationDismiss = validationError.getByRole("button", { name: "Dismiss error" });
  const [validationBox, validationDismissBox] = await Promise.all([validationError.boundingBox(), validationDismiss.boundingBox()]);
  expect(validationBox?.height || 0).toBeLessThanOrEqual(40);
  expect(Math.abs(
    ((validationBox?.y || 0) + (validationBox?.height || 0) / 2)
    - ((validationDismissBox?.y || 0) + (validationDismissBox?.height || 0) / 2)
  )).toBeLessThanOrEqual(1);
  await validationDismiss.click();
  await expect(validationError).toBeHidden();
  await justification.fill("Draft retained while reviewing roles");
  await backButton.click();
  await expect(page.getByRole("button", { name: /Continue with 1 selected/i })).toBeVisible();
  await expect(row.locator('input[type="checkbox"]')).toBeChecked();
  await page.getByRole("button", { name: /Continue with 1 selected/i }).click();
  await expect(justification).toHaveValue("Draft retained while reviewing roles");
  await expect(page.getByRole("tab", { name: "History" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel", { name: "Justification history" })).toContainText("Recent visual reason");
  await expect(page.getByRole("tabpanel", { name: "Justification history" })).not.toContainText("Saved visual reason");
  await page.getByRole("tab", { name: "Saved" }).click();
  await expect(page.getByRole("tabpanel", { name: "Saved justifications" })).toContainText("Saved visual reason");
  await expect(page.getByRole("tabpanel", { name: "Saved justifications" })).not.toContainText("Recent visual reason");
  await page.getByRole("tab", { name: "History" }).click();
  await page.evaluate(() => {
    const toolbar = document.querySelector<HTMLElement>(".toolbar");
    if (!toolbar) throw new Error("Popup toolbar is missing.");
    const progress = document.createElement("section");
    progress.className = "activation-progress-panel refresh-progress-panel smart-progress-panel";
    progress.setAttribute("role", "status");
    progress.innerHTML = `
      <div class="progress-line"><span>Activation in progress</span><span class="progress-fraction">Step 1/3</span></div>
      <p class="progress-detail">Sending activation request</p>
      <span class="progress-track"><span class="progress-fill" style="width: 30%"></span></span>
    `;
    toolbar.before(progress);
  });
  const reviewGeometry = await page.evaluate(() => {
    const shell = document.querySelector<HTMLElement>(".app-shell");
    const activationBar = document.querySelector<HTMLElement>(".activation-bar");
    const reviewScroll = document.querySelector<HTMLElement>(".activation-review-scroll");
    const footer = document.querySelector<HTMLElement>(".activation-review-actions");
    if (!shell || !activationBar || !reviewScroll || !footer) {
      throw new Error("Activation review layout is incomplete.");
    }
    reviewScroll.scrollTop = reviewScroll.scrollHeight;
    const shellRect = shell.getBoundingClientRect();
    const activationRect = activationBar.getBoundingClientRect();
    const reviewRect = reviewScroll.getBoundingClientRect();
    const footerRect = footer.getBoundingClientRect();
    return {
      documentScrollHeight: document.documentElement.scrollHeight,
      viewportHeight: window.innerHeight,
      shellBottom: shellRect.bottom,
      activationBottom: activationRect.bottom,
      reviewBottom: reviewRect.bottom,
      footerTop: footerRect.top,
      footerBottom: footerRect.bottom,
      reviewOverflowY: getComputedStyle(reviewScroll).overflowY,
      reviewClientHeight: reviewScroll.clientHeight,
      reviewScrollHeight: reviewScroll.scrollHeight
    };
  });
  expect(reviewGeometry.documentScrollHeight).toBeLessThanOrEqual(reviewGeometry.viewportHeight);
  expect(reviewGeometry.activationBottom).toBeLessThanOrEqual(reviewGeometry.viewportHeight);
  expect(reviewGeometry.activationBottom).toBeCloseTo(reviewGeometry.shellBottom, 0);
  expect(reviewGeometry.footerBottom).toBeLessThanOrEqual(reviewGeometry.shellBottom);
  expect(reviewGeometry.shellBottom - reviewGeometry.footerBottom).toBeLessThanOrEqual(8);
  expect(reviewGeometry.footerTop).toBeGreaterThanOrEqual(reviewGeometry.reviewBottom);
  expect(reviewGeometry.reviewOverflowY).toBe("auto");
  expect(reviewGeometry.reviewScrollHeight).toBeGreaterThan(reviewGeometry.reviewClientHeight);
  await assertNoHorizontalOverflow(page);
  await testInfo.attach("popup-selected", { body: await page.screenshot(), contentType: "image/png" });
  await page.close();
});

test("account details stay within the popup and keep copyable values on one line", async ({}, testInfo) => {
  await seedPopupIdentity(serviceWorker);
  const page = await openExtensionPage("popup.html", { width: 520, height: 600 });

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
  await seedPopupRole(serviceWorker);
  const page = await openExtensionPage("popup.html", { width: 520, height: 600 });
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

test("settings pages follow the user-journey information architecture", async ({}, testInfo) => {
  await seedPopupIdentity(serviceWorker);
  const page = await openExtensionPage("settings.html#display", { width: 1280, height: 900 });
  await expect(page.getByRole("heading", { name: "Popup & Appearance" })).toBeVisible();
  await expect(page.locator(".settings-nav-heading")).toHaveText([
    "Overview",
    "Access",
    "Personalization",
    "Activation",
    "Review",
    "Data & Support",
    "Product"
  ]);
  await expect(page.locator(".settings-nav button")).toHaveCount(13);
  await expect(page.getByText("Enabled tabs", { exact: true })).toBeVisible();
  await expect(page.getByText("Refresh behavior", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Role Access", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Role Access" })).toBeVisible();
  await expect(page.getByText("Enabled tabs", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Refresh behavior", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Access status & recovery", { exact: true })).toBeVisible();
  const contextValue = page.locator(".access-identity-value");
  await expect(contextValue).toBeVisible();
  const contextStyle = await contextValue.evaluate((element) => ({
    overflowWrap: getComputedStyle(element).overflowWrap,
    right: element.getBoundingClientRect().right,
    viewportWidth: window.innerWidth
  }));
  expect(contextStyle.overflowWrap).toBe("anywhere");
  expect(contextStyle.right).toBeLessThanOrEqual(contextStyle.viewportWidth);

  await page.setViewportSize({ width: 720, height: 800 });
  await assertNoHorizontalOverflow(page);
  const compactContextGeometry = await contextValue.evaluate((element) => ({
    right: element.getBoundingClientRect().right,
    viewportWidth: window.innerWidth,
    scrollWidth: element.scrollWidth,
    clientWidth: element.clientWidth
  }));
  expect(compactContextGeometry.right).toBeLessThanOrEqual(compactContextGeometry.viewportWidth);
  expect(compactContextGeometry.scrollWidth).toBeLessThanOrEqual(compactContextGeometry.clientWidth);
  await page.setViewportSize({ width: 1280, height: 900 });

  await page.getByRole("button", { name: "Browser Sync", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Browser Sync" })).toBeVisible();
  await expect(page.getByText("Native sync is unavailable for this installation")).toBeVisible();
  await assertNoHorizontalOverflow(page);

  await page.getByRole("button", { name: "Reset QuickPIM++", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Reset QuickPIM++" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open Backup & Restore" })).toBeVisible();

  await page.getByRole("button", { name: "Activation & Notifications", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Activation & Notifications" })).toBeVisible();
  await expect(page.getByLabel("Default activation duration")).toBeVisible();
  await expect(page.getByLabel("Default PIM extension duration")).toBeVisible();
  await expect(page.getByLabel("Notify me about request updates")).toBeVisible();
  await assertNoHorizontalOverflow(page);
  await testInfo.attach("settings-architecture", { body: await page.screenshot(), contentType: "image/png" });

  await page.setViewportSize({ width: 720, height: 800 });
  await assertNoHorizontalOverflow(page);
  await expect(page.getByRole("button", { name: "About", exact: true })).toBeVisible();
  await page.close();
});

test("saved and recent justifications align and recent reasons are copyable", async ({}, testInfo) => {
  await seedPopupRole(serviceWorker);
  const page = await openExtensionPage("settings.html#justifications", { width: 1000, height: 720 });

  await expect(page.getByRole("heading", { name: "Justifications" })).toBeVisible();
  const columns = page.locator(".justification-columns > .settings-subsection");
  await expect(columns).toHaveCount(2);
  const [savedBox, recentBox] = await Promise.all([columns.nth(0).boundingBox(), columns.nth(1).boundingBox()]);
  expect(Math.abs((savedBox?.y || 0) - (recentBox?.y || 0))).toBeLessThanOrEqual(1);

  const recentRow = page.locator(".recent-justification-row").first();
  const recentCopy = recentRow.getByRole("button", { name: "Copy recent justification" });
  await expect(recentCopy).toBeVisible();
  const [rowBox, copyBox] = await Promise.all([recentRow.boundingBox(), recentCopy.boundingBox()]);
  expect(copyBox?.x || 0).toBeGreaterThan((rowBox?.x || 0) + (rowBox?.width || 0) / 2);
  await recentCopy.click();
  await expect(recentRow.getByRole("button", { name: "recent justification copied" })).toBeVisible();
  await assertNoHorizontalOverflow(page);
  await testInfo.attach("settings-justifications", { body: await page.screenshot(), contentType: "image/png" });
  await page.close();
});

test("settings semantic surfaces remain distinct in light and dark modes", async ({}, testInfo) => {
  const page = await openExtensionPage("settings.html#appearance", { width: 1280, height: 900 });
  await setDarkMode(page, false);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Popup & Appearance" })).toBeVisible();
  const themeSwitch = page.getByRole("switch", { name: "Dark mode" });
  await expect(themeSwitch).toHaveAttribute("aria-checked", "false");
  await expect(themeSwitch.getByText("Light mode")).toBeVisible();
  await expect(themeSwitch.getByText("Dark mode")).toBeVisible();
  const lightColors = await readSettingsSurfaceColors(page);
  expect(lightColors.body).not.toBe(lightColors.panel);
  expect(lightColors.panel).not.toBe(lightColors.section);
  await assertNoHorizontalOverflow(page);
  await testInfo.attach("settings-light", { body: await page.screenshot(), contentType: "image/png" });

  await setDarkMode(page, true);
  await page.reload();
  await expect(page.locator("body.dark-mode")).toBeVisible();
  const darkColors = await readSettingsSurfaceColors(page);
  expect(darkColors.body).not.toBe(darkColors.panel);
  expect(darkColors.panel).not.toBe(darkColors.section);
  expect(darkColors.body).not.toBe(lightColors.body);
  await page.setViewportSize({ width: 720, height: 800 });
  await assertNoHorizontalOverflow(page);
  await testInfo.attach("settings-dark-compact", { body: await page.screenshot(), contentType: "image/png" });
  await setDarkMode(page, false);
  await page.close();
});

test("activity shows useful timestamps and a justification copy action", async ({}, testInfo) => {
  const page = await openExtensionPage("settings.html#activity", { width: 1000, height: 720 });
  await seedActivity(page);
  await page.reload();

  await expect(page.getByRole("heading", { name: "Activity & Usage" })).toBeVisible();
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

async function seedPopupRole(worker: Worker): Promise<void> {
  await worker.evaluate(async () => {
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
        recentJustifications: [
          "Recent visual reason",
          "Validate a production access request",
          "Review privileged configuration",
          "Complete an approved change",
          "Investigate a service incident",
          "Verify tenant security settings",
          "Update an administrative policy",
          "Perform a controlled support task"
        ],
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

async function seedPopupIdentity(worker: Worker): Promise<void> {
  await worker.evaluate(async () => {
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

async function setDarkMode(page: Page, darkMode: boolean): Promise<void> {
  await page.evaluate(async (enabled) => {
    const key = "quickPimSettings.v1";
    const stored = await chrome.storage.local.get(key);
    const settings = stored[key] as Record<string, unknown> | undefined;
    const preferences = (settings?.preferences || {}) as Record<string, unknown>;
    await chrome.storage.local.set({
      [key]: {
        ...settings,
        preferences: { ...preferences, darkMode: enabled }
      }
    });
  }, darkMode);
}

async function readSettingsSurfaceColors(page: Page): Promise<{ body: string; panel: string; section: string }> {
  return await page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>(".settings-layout > div > .panel");
    const section = document.querySelector<HTMLElement>(".preference-section");
    if (!panel || !section) throw new Error("Settings surfaces are missing.");
    return {
      body: getComputedStyle(document.body).backgroundColor,
      panel: getComputedStyle(panel).backgroundColor,
      section: getComputedStyle(section).backgroundColor
    };
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
