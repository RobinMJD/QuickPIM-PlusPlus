import { chromium, expect, test, type BrowserContext, type Page, type Worker } from "@playwright/test";
import path from "node:path";
import { rm } from "node:fs/promises";
import type { ActivationResponse, PimGroupItem } from "../../src/lib/types";

interface RetryHarness {
  writes: Array<Record<string, unknown>>;
  unexpectedRequests: string[];
  replacement: boolean;
  rejectWithNetworkError: boolean;
  activeFrom: string;
}

let context: BrowserContext;
let worker: Worker;
let extensionId: string;
let profilePath: string;
test.beforeEach(async ({}, testInfo) => {
  profilePath = testInfo.outputPath("synthetic-browser-profile");
  context = await launchBrowser();
  worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  extensionId = new URL(worker.url()).host;
});
async function launchBrowser(): Promise<BrowserContext> {
  return chromium.launchPersistentContext(profilePath, {
    channel: "chromium", headless: true, offline: true,
    args: [`--disable-extensions-except=${path.resolve("dist")}`, `--load-extension=${path.resolve("dist")}`]
  });
}
test.afterEach(async () => {
  await context.close();
  await rm(profilePath, { recursive: true, force: true });
});

test("offers a retry, survives popup closure, and disables only once after the minimum", async ({}, testInfo) => {
  const item = await installHarness();
  let page = await openPopup();
  const issues: string[] = [];
  page.on("pageerror", (error) => issues.push(error.message));
  page.on("console", (message) => { if (["error", "warning"].includes(message.type())) issues.push(message.text()); });
  await requestDisable(page, item);
  const panel = page.getByRole("region", { name: "Disable retries" });
  await expect(panel.getByRole("button", { name: /Retry automatically at/ })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("retry-offer.png") });
  await panel.getByRole("button", { name: /Retry automatically at/ }).click();
  await expect(panel).toContainText("Disable queued for");
  await expect(panel.getByRole("button", { name: "Cancel retry" })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("region", { name: "Disable retries" })).toContainText("You can close this popup");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("retry-queued.png") });
  await page.close();
  await expect.poll(async () => (await evidence()).entries[0]?.state, { timeout: 20_000 }).toBe("submitted");
  const result = await evidence();
  expect(result.writes).toHaveLength(2);
  expect(result.writes[1]).toMatchObject({ action: "selfDeactivate", groupId: item.groupId, principalId: item.principalId, targetScheduleId: "schedule-original" });
  expect(result.unexpectedRequests).toEqual([]);
  page = await openPopup();
  await expect(page.getByRole("region", { name: "Disable retries" })).toContainText("Disable requested");
  // Chromium can warn that extension modulepreloads cross isolated worlds;
  // these resource-hint warnings do not indicate an app execution failure.
  expect(issues.filter((text) => !/^A preload for 'chrome-extension:\/\/[^']+' is found, but is not used because it is a cross-world extension resource mismatch\.$/.test(text))).toEqual([]);
});

test("Cancel retry removes the alarm and pending intent", async () => {
  const item = await installHarness();
  let page = await openPopup();
  await requestDisable(page, item);
  await page.getByRole("button", { name: /Retry automatically at/ }).click();
  await expect(page.getByRole("button", { name: "Cancel retry" })).toBeVisible();
  // Restart the real browser with the same synthetic profile and a missing
  // Chrome alarm. Startup must restore the durable queued intent.
  await worker.evaluate(() => chrome.alarms.clear("quickpim-deactivation-retry"));
  await context.close();
  context = await launchBrowser();
  worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  page = await openPopup();
  await expect.poll(async () => Boolean((await evidenceWithoutHarness()).alarm)).toBe(true);
  await expect(page.getByRole("button", { name: "Cancel retry" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel retry" }).click();
  await expect(page.getByRole("region", { name: "Disable retries" })).toHaveCount(0);
  const result = await evidenceWithoutHarness();
  expect(result.entries).toEqual([]);
  expect(result.alarm).toBeUndefined();
});

test("a replacement activation is never disabled by the earlier queued request", async () => {
  const item = await installHarness();
  const page = await openPopup();
  await requestDisable(page, item);
  await page.getByRole("button", { name: /Retry automatically at/ }).click();
  await worker.evaluate(() => { (globalThis as any).retryHarness.replacement = true; });
  await expect.poll(async () => (await evidence()).entries[0]?.state, { timeout: 20_000 }).toBe("failed");
  await expect(page.getByRole("region", { name: "Disable retries" })).toContainText("original activation");
  expect((await evidence()).writes).toHaveLength(1);
});

test("an ambiguous write failure never offers or schedules an automatic retry", async () => {
  const item = await installHarness(true);
  const page = await openPopup();
  const reply = await page.evaluate((selected) => chrome.runtime.sendMessage({
    action: "deactivateItems", operationId: "uncertain-disable", items: [selected], justification: "Incorrect role selected"
  }), item) as { data: ActivationResponse };
  expect(reply.data.results[0].outcomeUnknown).toBe(true);
  const result = await evidence();
  expect(result.entries).toEqual([]);
  expect(result.alarm).toBeUndefined();
  expect(result.writes).toHaveLength(1);
});

async function openPopup(): Promise<Page> {
  const page = await context.newPage();
  await page.setViewportSize({ width: 520, height: 600 });
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(page).toHaveTitle(/QuickPIM/);
  await expect(page.getByRole("heading", { name: "QuickPIM++" })).toBeVisible();
  return page;
}

async function requestDisable(page: Page, item: PimGroupItem): Promise<void> {
  const row = page.locator(".role-row").filter({ hasText: item.displayName });
  await expect(row).toBeVisible();
  await row.locator('input[type="checkbox"]').check();
  await page.getByRole("button", { name: /Continue/ }).click();
  await page.getByRole("button", { name: "Disable 1 selected", exact: true }).click();
  await expect(page.getByRole("button", { name: /Retry automatically at/ })).toBeVisible();
}

async function evidenceWithoutHarness() {
  return worker.evaluate(async () => {
    const stored = await chrome.storage.local.get("quickPimDeactivationRetries.v1");
    return { entries: stored["quickPimDeactivationRetries.v1"] || [],
      alarm: await chrome.alarms.get("quickpim-deactivation-retry") };
  });
}

async function evidence() {
  return worker.evaluate(async () => {
    const harness = (globalThis as any).retryHarness as RetryHarness;
    const stored = await chrome.storage.local.get("quickPimDeactivationRetries.v1");
    return { ...harness, entries: (stored["quickPimDeactivationRetries.v1"] || []) as Array<{ state: string }>,
      alarm: await chrome.alarms.get("quickpim-deactivation-retry") };
  });
}

async function installHarness(rejectWithNetworkError = false): Promise<PimGroupItem> {
  return worker.evaluate(async (rejectNetwork) => {
    const now = Date.now();
    // Leave enough time to observe the offer and close the popup. Real Chrome
    // alarms execute the production background handler; no five-minute sleep.
    const activeFrom = new Date(now - 5 * 60_000 + 8_000).toISOString();
    const item: PimGroupItem = {
      id: "pimGroup:group-retry:owner", type: "pimGroup", groupId: "group-retry", accessId: "owner",
      tenantId: "tenant-retry", principalId: "principal-retry", sourceName: "Demo GitHub Enterprise Owners",
      displayName: "Demo GitHub Enterprise Owners", scopeLabel: "Owner", status: "active", activeAssignmentType: "activated",
      activeFrom, activeUntil: new Date(now + 3600_000).toISOString(),
      assignmentScheduleId: "schedule-original", assignmentScheduleInstanceId: "instance-original"
    };
    const harness: RetryHarness = { writes: [], unexpectedRequests: [], replacement: false, rejectWithNetworkError: rejectNetwork, activeFrom };
    (globalThis as any).retryHarness = harness;
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const parsed = new URL(url);
      if (parsed.origin === "https://graph.microsoft.com" && init?.method === "POST" && parsed.pathname.endsWith("/assignmentScheduleRequests")) {
        const body = JSON.parse(String(init.body));
        harness.writes.push(body);
        if (harness.rejectWithNetworkError) return json({ error: { code: "ServiceUnavailable", message: "Service unavailable" } }, 503);
        if (Date.now() < Date.parse(activeFrom) + 5 * 60_000) return json({ error: { code: "BadRequest", message: "The Active duration is too short. Miniumum Required is 5 minutes." } }, 400);
        return json({ id: "disable-retry-accepted", ...body, status: "Revoked" }, 201);
      }
      if (parsed.origin === "https://graph.microsoft.com" && parsed.pathname.endsWith("/$batch")) {
        const body = JSON.parse(String(init?.body));
        return json({ responses: body.requests.map((request: { id: string }) => ({ id: request.id, status: 200, body: { id: item.groupId, displayName: item.displayName } })) });
      }
      if (parsed.origin === "https://graph.microsoft.com" && (!init?.method || init.method === "GET")) {
        if (parsed.pathname.includes("/assignmentScheduleInstances/")) return json({ value: [{
          id: harness.replacement ? "instance-new" : item.assignmentScheduleInstanceId,
          assignmentScheduleId: harness.replacement ? "schedule-new" : item.assignmentScheduleId,
          groupId: item.groupId, principalId: item.principalId, accessId: item.accessId,
          assignmentType: "Activated", startDateTime: activeFrom, endDateTime: item.activeUntil
        }] });
        if (parsed.pathname.includes("/groups/")) return json({ id: item.groupId, displayName: item.displayName });
        return json({ value: [] });
      }
      harness.unexpectedRequests.push(`${init?.method || "GET"} ${parsed.origin}${parsed.pathname}`);
      throw new Error("Unexpected request in offline retry test");
    };
    const encode = (value: unknown) => btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    const scope = "PrivilegedAccess.ReadWrite.AzureADGroup";
    const token = `${encode({ alg: "none" })}.${encode({ aud: "https://graph.microsoft.com", exp: Math.floor(now / 1000) + 3600,
      tid: item.tenantId, oid: item.principalId, scp: scope })}.signature`;
    const cacheKey = `graphPimGroup:${item.tenantId}:${item.principalId}:${scope}:generation=${now}`;
    await chrome.storage.local.set({
      "quickPimSettings.v1": { preferences: { enabledFeatures: ["pimGroup"], autoEnabledFeaturesInitialized: true,
        backgroundPreRefreshEnabled: false, permissionWarningIgnored: true } },
      "quickPimDataCache.v1": { eligibleByTarget: { pimGroup: { items: [], errors: [], fetchedAt: now, cacheKey } },
        activeByTarget: { pimGroup: { items: [item], errors: [], fetchedAt: now, cacheKey } } }
    });
    await chrome.storage.session.set({ graphToken: token, tokenTimestamp: now, tokenSource: "portal" });
    return item;
  }, rejectWithNetworkError);
}
