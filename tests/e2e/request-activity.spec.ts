import { chromium, expect, test, type BrowserContext, type Page, type Worker } from "@playwright/test";
import { cp, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { buildTargetCacheKey } from "../../src/lib/access";
import { makeTokenStatus } from "../../src/lib/token";
import { createRequestOperationItems } from "../../src/lib/requestOperations";
import type { ActivationItem, RequestOperationRecord, TokenStatus } from "../../src/lib/types";

let context: BrowserContext, worker: Worker, extensionId: string, extensionPath: string, profile: string;
const tenant = "11111111-1111-4111-8111-111111111111", principal = "22222222-2222-4222-8222-222222222222";
const reason = "Resolve the approved access incident for the application team";
let items: ActivationItem[];
let consoleIssues: string[];
test.beforeEach(async ({}, info) => {
  consoleIssues = [];
  extensionPath = info.outputPath("instrumented-extension"); profile = info.outputPath("synthetic-profile");
  await cp(path.resolve("dist"), extensionPath, { recursive: true });
  // Install the same offline Microsoft stub before production initialization on
  // every worker start. The built application code itself is unmodified.
  const background = path.join(extensionPath, "background.js");
  await writeFile(background, `(${installOfflineMicrosoft.toString()})();\n${await readFile(background, "utf8")}`);
  await launch();
  items = fixtures(); await seed();
});
test.afterEach(async () => {
  const relevantIssues = consoleIssues.filter((text) =>
    !/^A preload for 'chrome-extension:\/\/[^']+' is found, but is not used because it is a cross-world extension resource mismatch\.$/.test(text)
    && !/^The resource chrome-extension:\/\/[^ ]+ was preloaded using link preload but not used within a few seconds from the window's load event\. Please make sure it has an appropriate `as` value and it is preloaded intentionally\.$/.test(text));
  await context.close(); await rm(profile, { recursive: true, force: true }); await rm(extensionPath, { recursive: true, force: true }); expect(relevantIssues).toEqual([]); });
async function launch() {
  context = await chromium.launchPersistentContext(profile, { channel: "chromium", headless: true, offline: true, viewport: { width: 520, height: 600 }, args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] });
  worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker"); extensionId = new URL(worker.url()).host;
  // Inspect application console output. Portal-recovery tabs are deliberately
  // offline and their expected network errors are outside the app surface.
  context.on("page", (page) => {
    page.on("pageerror", (error) => { if (page.url().startsWith(`chrome-extension://${extensionId}/`)) consoleIssues.push(error.message); });
    page.on("console", (message) => { if (page.url().startsWith(`chrome-extension://${extensionId}/`) && ["error", "warning"].includes(message.type())) consoleIssues.push(message.text()); });
  });
  // A worker target is announced before its module listeners necessarily load.
  // Real token capture needs those listeners too; do not seed synthetic access
  // before production can receive storage changes. This does not open a popup
  // or invoke request recovery itself.
  await expect.poll(() => worker.evaluate(() => chrome.runtime.onMessage.hasListeners())).toBe(true);
}
function fixtures(): ActivationItem[] {
  const base = { tenantId: tenant, principalId: principal, status: "eligible" as const, activationPolicyState: "ready" as const, activationRequirements: { justification: false, ticket: false, maxDurationHours: 8 } };
  return [
    { ...base, type: "pimGroup", id: "pimGroup:group-a:member", groupId: "group-a", accessId: "member", displayName: "Application Support", sourceName: "Application Support", scopeLabel: "Member" },
    { ...base, type: "pimGroup", id: "pimGroup:group-b:owner", groupId: "group-b", accessId: "owner", displayName: "Deployment Owners", sourceName: "Deployment Owners", scopeLabel: "Owner" },
    { ...base, type: "directoryRole", id: "directoryRole:role-a:/administrativeUnits/unit-a", roleDefinitionId: "role-a", directoryScopeId: "/administrativeUnits/unit-a", displayName: "Groups Administrator", sourceName: "Groups Administrator", scopeLabel: "Restricted unit A" },
    { ...base, type: "azureRole", id: "azureRole:role-a:/subscriptions/sub-a", roleDefinitionId: "/subscriptions/sub-a/providers/Microsoft.Authorization/roleDefinitions/role-a", scope: "/subscriptions/sub-a", displayName: "Contributor", sourceName: "Contributor", scopeLabel: "Subscription A" }
  ];
}
async function seed(restoreOnlyTokens = false) {
  const now = Date.now();
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const token = (aud: string, scp?: string) => `${encode({ alg: "none" })}.${encode({ aud, tid: tenant, oid: principal, preferred_username: "tester@example.invalid", exp: Math.floor(now / 1000) + 3600, ...(scp ? { scp } : {}) })}.signature`;
  const graph = token("https://graph.microsoft.com", "RoleAssignmentSchedule.ReadWrite.Directory PrivilegedAccess.ReadWrite.AzureADGroup");
  const azure = token("https://management.azure.com/");
  const entry = makeTokenStatus(graph, now, "portal");
  const status: TokenStatus = { graph: entry, graphTargets: { directoryRole: entry, pimGroup: entry }, azureManagement: makeTokenStatus(azure, now, "portal") };
  const cache = { eligibleByTarget: Object.fromEntries(["directoryRole", "pimGroup", "azureRole"].map((target) => [target, { fetchedAt: now, cacheKey: buildTargetCacheKey(status, target as ActivationItem["type"]), errors: [], items: items.filter((item) => item.type === target) }])), activeByTarget: Object.fromEntries(["directoryRole", "pimGroup", "azureRole"].map((target) => [target, { fetchedAt: now, cacheKey: buildTargetCacheKey(status, target as ActivationItem["type"]), errors: [], items: [] }])) };
  await worker.evaluate(async ({ now, graph, azure, cache, items, restoreOnlyTokens }) => {
    if (!restoreOnlyTokens) await chrome.storage.local.set({
      "requestTestHarness": { hold: true, writes: [], unexpected: [], approval: false, items },
      "quickPimSettings.v1": { preferences: { enabledFeatures: ["directoryRole", "pimGroup", "azureRole", "bundles"], autoEnabledFeaturesInitialized: true, defaultDurationHours: 4, backgroundPreRefreshEnabled: false, permissionWarningIgnored: true }, bundles: [{ id: "bundle-a", name: "Incident response", itemIds: [items[0].id, items[1].id], defaultDurationHours: 2 }] },
      "quickPimDataCache.v1": cache
    });
    await chrome.storage.session.set({ graphToken: graph, tokenTimestamp: now, tokenSource: "portal", azureManagementToken: azure, azureManagementTokenTimestamp: now, azureManagementTokenSource: "portal" });
  }, { now, graph, azure, cache, items, restoreOnlyTokens });
}
async function popup() { const page = await context.newPage(); await page.goto(`chrome-extension://${extensionId}/popup.html`); return page; }
async function evidence() { return worker.evaluate(async () => { const data = await chrome.storage.local.get(["requestTestHarness", "quickPimRequestOperations.v2", "quickPimPopupDraft.v1"]); return { harness: data.requestTestHarness as { hold: boolean; writes: Array<Record<string, any>>; unexpected: string[] }, operations: (data["quickPimRequestOperations.v2"] || []) as RequestOperationRecord[], draft: data["quickPimPopupDraft.v1"] }; }); }
async function release(approval = false) { await expect.poll(async () => (await evidence()).harness.writes.length).toBeGreaterThan(0); await worker.evaluate(async (approval) => { const data = await chrome.storage.local.get("requestTestHarness"); await chrome.storage.local.set({ requestTestHarness: { ...data.requestTestHarness, hold: false, approval } }); }, approval); }
async function submitFromUI(page: Page, name: string) {
  await page.getByRole("tab", { name: "PIM Groups", exact: true }).click();
  await page.locator(".role-row").filter({ hasText: name }).locator('input[type="checkbox"]').check();
  await page.getByRole("button", { name: /Continue/ }).click();
  await page.getByRole("button", { name: "Activate 1 selected", exact: true }).click();
}
async function start(page: Page, selected: ActivationItem[], action = "activateItems", extra: Record<string, unknown> = {}) {
  return page.evaluate(async ({ selected, action, extra, reason }) => chrome.runtime.sendMessage({ action: "startRequestOperation", request: { action, items: selected, operationId: crypto.randomUUID(), durationHours: 4, justification: reason, ...extra } }), { selected, action, extra, reason });
}

test("popup closure preserves a running activation, its parameters, and a separate new request", async ({}, info) => {
  let page = await popup(); const issues: string[] = [];
  page.on("pageerror", (error) => issues.push(error.message));
  await submitFromUI(page, items[0].displayName);
  await expect(page.getByRole("region", { name: "Requests", exact: true })).toContainText("1 request in progress");
  await expect(page.getByRole("button", { name: "Back to role selection" })).toHaveCount(0);
  await page.close();
  await expect.poll(async () => (await evidence()).harness.writes.length).toBe(1);
  page = await popup();
  await expect(page.getByRole("region", { name: "Requests", exact: true })).toContainText("1 request in progress");
  await expect(page.getByRole("progressbar", { name: "Request progress", exact: true })).toBeInViewport({ ratio: 1 });
  await page.getByRole("button", { name: "View requests" }).click();
  await expect(page.getByRole("region", { name: "Requests", exact: true })).toContainText("Application Support");
  await expect(page.getByRole("region", { name: "Requests", exact: true })).toContainText("4 hours");
  await expect(page.getByRole("region", { name: "Requests", exact: true })).toContainText("Submitting to Microsoft");
  expect(await page.locator(".smart-progress-panel").count()).toBe(0);
  await page.screenshot({ path: info.outputPath("requests-expanded.png") });
  await page.getByRole("button", { name: "Hide requests" }).click();
  await submitFromUI(page, items[1].displayName);
  await expect(page.getByRole("region", { name: "Requests", exact: true })).toContainText("2 requests in progress");
  await expect.poll(async () => (await evidence()).harness.writes.length).toBe(2);
  const snapshot = await evidence();
  expect(snapshot.operations).toHaveLength(2);
  expect(snapshot.operations.find((op) => op.items?.[0].itemName === "Application Support")?.durationHours).toBe(4);
  await page.screenshot({ path: info.outputPath("requests-compact.png") });
  await page.close(); await release();
  await expect.poll(async () => (await evidence()).operations.every((op) => op.state === "complete")).toBe(true);
  page = await popup(); await page.getByRole("button", { name: "View requests" }).click();
  await expect(page.getByRole("region", { name: "Requests", exact: true })).toContainText("Active");
  expect((await evidence()).harness.writes).toHaveLength(2);
  expect((await evidence()).harness.unexpected).toEqual([]);
  expect(issues).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight && document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("closing immediately after Activate still hands off exactly once", async () => {
  const page = await popup();
  await page.getByRole("tab", { name: "PIM Groups", exact: true }).click();
  await page.locator(".role-row").filter({ hasText: items[0].displayName }).locator('input[type="checkbox"]').check();
  await page.getByRole("button", { name: /Continue/ }).click();
  await page.getByRole("button", { name: "Activate 1 selected", exact: true }).click({ noWaitAfter: true });
  await page.close();
  await expect.poll(async () => (await evidence()).harness.writes.length).toBe(1);
  await release();
  const reopened = await popup(); await expect(reopened.getByRole("button", { name: "Activate 1 selected", exact: true })).toHaveCount(0);
  expect((await evidence()).harness.writes).toHaveLength(1);
});

test("directory, Azure and bundle requests have independent durable progress and partial results", async () => {
  const page = await popup();
  const result = await start(page, [items[2], items[3]], "activateItems", { bundleName: "Cross-source incident", durationHours: 2 });
  expect(result.success).toBe(true);
  await page.close();
  await expect.poll(async () => (await evidence()).harness.writes.length).toBe(2);
  const reopened = await popup(); await reopened.getByRole("button", { name: "View requests" }).click();
  await expect(reopened.getByRole("region", { name: "Requests", exact: true })).toContainText("Cross-source incident");
  await expect(reopened.getByRole("region", { name: "Requests", exact: true })).toContainText("Restricted unit A");
  await expect(reopened.getByRole("region", { name: "Requests", exact: true })).toContainText("Subscription A");
  await release(true);
  await expect.poll(async () => (await evidence()).operations[0].state).toBe("complete");
  await expect(reopened.getByRole("region", { name: "Requests", exact: true })).toContainText("Awaiting approval");
  const duplicate = await start(reopened, [items[2]]);
  expect(duplicate.success).toBe(false);
  expect((await evidence()).harness.writes).toHaveLength(2);
});

test("deactivation continues after popup closure and reports its own parameters", async () => {
  const page = await popup();
  const active = { ...items[0], status: "active", activeAssignmentType: "activated", assignmentScheduleId: "schedule-a", assignmentScheduleInstanceId: "instance-a", activeFrom: new Date(Date.now() - 10 * 60_000).toISOString(), activeUntil: new Date(Date.now() + 3600_000).toISOString() } as ActivationItem;
  const result = await start(page, [active], "deactivateItems", { justification: "Incident finished; remove temporary access" });
  expect(result, JSON.stringify(result)).toMatchObject({ success: true }); await page.close();
  await expect.poll(async () => (await evidence()).harness.writes.length).toBe(1);
  await release();
  const reopened = await popup(); await reopened.getByRole("button", { name: "View requests" }).click();
  await expect(reopened.getByRole("region", { name: "Requests", exact: true })).toContainText("Deactivate");
  await expect(reopened.getByRole("region", { name: "Requests", exact: true })).toContainText("Deactivated");
  expect((await evidence()).harness.writes[0]).toMatchObject({ action: "selfDeactivate", targetScheduleId: "schedule-a" });
});

test("access extensions use durable progress after their requesting page closes", async () => {
  const page = await popup();
  const source = { id: "tracked-original", itemId: items[0].id, itemType: "pimGroup", itemName: items[0].displayName, action: "activate", requestId: "source-original", principalId: principal, tenantId: tenant, groupId: "group-a", accessId: "member", scopeLabel: "Member", status: "active", requestedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), activeUntil: new Date(Date.now() + 3600_000).toISOString(), durationHours: 1, justification: reason, activationRequirements: { justification: false, ticket: false }, checkCount: 0 };
  await worker.evaluate(async (source) => chrome.storage.local.set({ "quickPimRequests.v1": { version: 1, requests: [source] } }), source);
  const result = await page.evaluate(async () => chrome.runtime.sendMessage({ action: "startRequestOperation", request: { action: "extendTrackedRequest", requestId: "source-original" } }));
  expect(result, JSON.stringify(result)).toMatchObject({ success: true }); await page.close();
  await expect.poll(async () => (await evidence()).harness.writes.length).toBe(1);
  const reopened = await popup(); await reopened.getByRole("button", { name: "View requests" }).click();
  await expect(reopened.getByRole("region", { name: "Requests", exact: true })).toContainText("Extend");
  expect((await evidence()).operations[0]).toMatchObject({ kind: "extension", sourceRequestId: "source-original", durationHours: 0.5 });
  await release(); await expect.poll(async () => (await evidence()).operations[0].state).toBe("complete");
  expect((await evidence()).harness.writes).toHaveLength(1);
});

test("real browser restart preserves uncertain writes without submitting them again", async ({}, info) => {
  const page = await popup(); expect((await start(page, [items[0]])).success).toBe(true);
  await expect.poll(async () => (await evidence()).harness.writes.length).toBe(1);
  const originalId = (await evidence()).operations[0].id;
  await context.close(); await launch();
  const reopened = await popup(); await reopened.getByRole("button", { name: "View requests" }).click();
  await expect(reopened.getByRole("region", { name: "Requests", exact: true })).toContainText("Outcome unknown");
  await expect(reopened.getByRole("button", { name: "Activate 1 selected", exact: true })).toHaveCount(0);
  await reopened.screenshot({ path: info.outputPath("request-restart-uncertain.png") });
  const snapshot = await evidence(); expect(snapshot.operations[0].popupResultSeenAt).toBeUndefined(); expect(snapshot.operations[0].id).toBe(originalId); expect(snapshot.operations[0].justification).toBe(reason);
  expect(snapshot.harness.writes).toHaveLength(1);
  await seed(true); await reopened.reload();
  expect((await evidence()).harness.writes).toHaveLength(1);
});

test("real browser restart resumes only never-sent items after original-account access returns", async () => {
  const now = Date.now();
  const op: RequestOperationRecord = { id: "restart_prepared_1234", action: "activate", itemIds: [items[0].id], targets: ["pimGroup"], tenantId: tenant, principalId: principal, items: createRequestOperationItems([items[0]], now), state: "running", startedAt: now, updatedAt: now, durationHours: 4, justification: reason, resumePayload: { items: [items[0]], durationHours: 4, justification: reason } };
  await worker.evaluate(async (op) => chrome.storage.local.set({ "quickPimRequestOperations.v2": [op] }), op);
  await context.close(); await launch();
  const reopened = await popup(); await reopened.getByRole("button", { name: "View requests" }).click();
  await expect(reopened.getByRole("region", { name: "Requests", exact: true })).toContainText("Waiting for Microsoft access");
  expect((await evidence()).harness.writes).toHaveLength(0);
  await seed(true); await release();
  await expect.poll(async () => (await evidence()).operations[0].state).toBe("complete");
  expect((await evidence()).harness.writes).toHaveLength(1);
  expect((await evidence()).operations[0].id).toBe(op.id);
});

test("bundle activation survives closure and presents each partial result", async () => {
  const page = await popup(); await page.getByRole("tab", { name: "Bundles", exact: true }).click();
  await page.getByRole("button", { name: "Activate now as-is", exact: true }).click(); await page.close();
  await expect.poll(async () => (await evidence()).harness.writes.length).toBe(2);
  await worker.evaluate(async () => { const data = await chrome.storage.local.get("requestTestHarness"); await chrome.storage.local.set({ requestTestHarness: { ...data.requestTestHarness, failGroup: "group-b" } }); });
  await release();
  await expect.poll(async () => (await evidence()).operations[0].state).toBe("complete");
  const reopened = await popup(); await reopened.getByRole("button", { name: "View requests" }).click();
  const panel = reopened.getByRole("region", { name: "Requests", exact: true });
  await expect(panel).toContainText("Incident response"); await expect(panel).toContainText("2 hours");
  await expect(panel).toContainText("Active"); await expect(panel).toContainText("Failed");
  expect((await evidence()).operations[0].response?.errors).toHaveLength(1);
});

test("accepted approval requests keep their identity and status across a real browser restart", async () => {
  const page = await popup(); expect((await start(page, [items[0]])).success).toBe(true);
  await release(true); await expect.poll(async () => (await evidence()).operations[0].state).toBe("complete");
  const id = (await evidence()).operations[0].id; await context.close(); await launch();
  const reopened = await popup(); await reopened.getByRole("button", { name: "View requests" }).click();
  await expect(reopened.getByRole("region", { name: "Requests", exact: true })).toContainText("Awaiting approval");
  expect((await evidence()).operations[0].popupResultSeenAt).toBeUndefined();
  expect((await evidence()).operations[0].id).toBe(id); expect((await evidence()).harness.writes).toHaveLength(1);
});

test("completion of an older request does not reset a new form or its selected duration", async () => {
  const page = await popup(); await submitFromUI(page, items[0].displayName);
  await expect.poll(async () => (await evidence()).harness.writes.length).toBe(1);
  await page.locator(".role-row").filter({ hasText: items[1].displayName }).locator('input[type="checkbox"]').check();
  await page.getByRole("button", { name: /Continue/ }).click();
  const duration = page.locator(".activation-bar select"); await duration.selectOption("2");
  await release(); await expect.poll(async () => (await evidence()).operations[0].state).toBe("complete");
  await expect(duration).toHaveValue("2"); await expect(page.getByRole("button", { name: "Activate 1 selected", exact: true })).toBeVisible();
  await page.close(); const reopened = await popup();
  await expect(reopened.locator(".activation-bar select")).toHaveValue("2");
  expect((await evidence()).harness.writes).toHaveLength(1);
});

for (const type of ["directoryRole", "azureRole"] as const) {
  test(`${type} deactivation survives closing its requesting popup`, async () => {
    const page = await popup(); const item = items.find((item) => item.type === type)!;
    const active = { ...item, status: "active", activeAssignmentType: "activated", assignmentScheduleId: "schedule-a", assignmentScheduleInstanceId: "instance-a", activeUntil: new Date(Date.now() + 3600_000).toISOString() } as ActivationItem;
    const result = await start(page, [active], "deactivateItems"); expect(result, JSON.stringify(result)).toMatchObject({ success: true }); await page.close();
    await expect.poll(async () => (await evidence()).harness.writes.length).toBe(1); await release();
    await expect.poll(async () => (await evidence()).operations[0].state).toBe("complete");
    const reopened = await popup(); await reopened.getByRole("button", { name: "View requests" }).click();
    await expect(reopened.getByRole("region", { name: "Requests", exact: true })).toContainText("Deactivated");
  });
  test(`${type} extension survives closing its requesting popup`, async () => {
    const page = await popup(); const item = items.find((item) => item.type === type)!;
    const source = { ...item, id: "source-extension", itemId: item.id, itemType: item.type, itemName: item.displayName, ...(item.type === "azureRole" ? { azureScope: item.scope, roleEligibilityScheduleId: "eligibility-original" } : {}), action: "activate", requestId: "source-original", status: "active", requestedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), activeUntil: new Date(Date.now() + 3600_000).toISOString(), justification: reason, checkCount: 0 };
    await worker.evaluate(async (source) => chrome.storage.local.set({ "quickPimRequests.v1": { version: 1, requests: [source] } }), source);
    const result = await page.evaluate(async () => chrome.runtime.sendMessage({ action: "startRequestOperation", request: { action: "extendTrackedRequest", requestId: "source-original" } }));
    expect(result, JSON.stringify(result)).toMatchObject({ success: true }); await page.close();
    await expect.poll(async () => (await evidence()).harness.writes.length).toBe(1); await release();
    await expect.poll(async () => (await evidence()).operations[0].state).toBe("complete");
    expect((await evidence()).operations[0]).toMatchObject({ kind: "extension", sourceRequestId: "source-original" });
  });
}

test("a restarted batch resumes its unsent item but never replays its uncertain item", async () => {
  const now = Date.now(); const records = createRequestOperationItems(items.slice(0, 2), now); records[0].state = "uncertain";
  const op: RequestOperationRecord = { id: "restart_partial_1234", action: "activate", itemIds: items.slice(0, 2).map((item) => item.id), targets: ["pimGroup"], tenantId: tenant, principalId: principal, items: records, state: "uncertain", startedAt: now, updatedAt: now, durationHours: 4, justification: reason, resumePayload: { items: items.slice(0, 2), durationHours: 4, justification: reason } };
  await worker.evaluate(async (op) => {
    const data = await chrome.storage.local.get("requestTestHarness");
    await chrome.storage.local.set({ "quickPimRequestOperations.v2": [op], requestTestHarness: { ...data.requestTestHarness, writes: [{ groupId: "group-a", action: "selfActivate", testId: "request-1" }] } });
  }, op);
  await context.close(); await launch(); await seed(true);
  await expect.poll(async () => (await evidence()).harness.writes.length).toBe(2); await release();
  await expect.poll(async () => (await evidence()).operations[0].response?.results.length).toBe(2);
  const snapshot = await evidence();
  expect(snapshot.operations[0].state).toBe("uncertain");
  expect(snapshot.harness.writes).toHaveLength(2);
  expect(snapshot.harness.writes.filter((write) => write.groupId === "group-a")).toHaveLength(1);
  expect(snapshot.harness.writes.filter((write) => write.groupId === "group-b")).toHaveLength(1);
  expect(snapshot.operations[0].id).toBe(op.id);
  expect(snapshot.operations[0].resumePayload).toBeUndefined();
});

test("request details remain usable in dark mode and through keyboard navigation", async ({}, info) => {
  await worker.evaluate(async () => {
    const data = await chrome.storage.local.get("quickPimSettings.v1");
    await chrome.storage.local.set({ "quickPimSettings.v1": { ...data["quickPimSettings.v1"], preferences: { ...data["quickPimSettings.v1"].preferences, darkMode: true } } });
  });
  const page = await popup(); await start(page, [items[2]], "activateItems", { ticketInfo: { ticketSystem: "ServiceNow", ticketNumber: "INC-1245" } });
  const view = page.getByRole("button", { name: "View requests" }); await view.focus(); await page.keyboard.press("Enter");
  const parameters = page.locator(".request-activity-card summary"); await parameters.focus(); await page.keyboard.press("Enter");
  await expect(page.locator(".request-activity-card details")).toHaveAttribute("open", "");
  await expect(page.getByRole("region", { name: "Requests", exact: true })).toContainText("INC-1245");
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: info.outputPath("requests-dark-details.png") });
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight && document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await release();
});

for (const darkMode of [false, true]) {
  test(`request progress and expanded details stay visible above a long role list (${darkMode ? "dark" : "light"})`, async ({}, info) => {
    items = [...items, ...Array.from({ length: 30 }, (_, index) => ({ ...items[0], id: `pimGroup:extra-${index}:member`, groupId: `extra-${index}`, displayName: `Additional eligible role ${index + 1}`, sourceName: `Additional eligible role ${index + 1}` }))];
    await seed();
    if (darkMode) await worker.evaluate(async () => {
      const data = await chrome.storage.local.get("quickPimSettings.v1");
      await chrome.storage.local.set({ "quickPimSettings.v1": { ...data["quickPimSettings.v1"], preferences: { ...data["quickPimSettings.v1"].preferences, darkMode: true } } });
    });
    const page = await popup();
    const syncReminder = page.getByRole("button", { name: "Do not remind me", exact: true });
    if (await syncReminder.isVisible()) await syncReminder.click();
    await page.getByRole("tab", { name: "PIM Groups", exact: true }).click();
    await start(page, [items[0]]);
    await expect(page.getByRole("region", { name: "Requests", exact: true })).toContainText("1 request in progress");
    await expect(page.getByRole("progressbar", { name: "Request progress", exact: true })).toBeInViewport({ ratio: 1 });
    await page.getByRole("button", { name: "View requests", exact: true }).click();
    await page.screenshot({ path: info.outputPath(`request-panel-${darkMode ? "dark" : "light"}.png`) });
    const details = page.locator("#request-activity-details");
    expect(await details.evaluate((element) => element.clientHeight)).toBeGreaterThan(100);
    await expect(page.getByRole("article", { name: "Activate Application Support", exact: true })).toBeInViewport();
    await expect(page.getByText("Submitting to Microsoft", { exact: true })).toBeInViewport();
    await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeInViewport({ ratio: 1 });
    await page.getByRole("button", { name: "Hide requests", exact: true }).click();
    await submitFromUI(page, items[1].displayName);
    await expect(page.getByRole("region", { name: "Requests", exact: true })).toContainText("2 requests in progress");
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight && document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await release();
    await expect.poll(async () => (await evidence()).operations.every((op) => op.state === "complete")).toBe(true);
    await expect(page.getByRole("progressbar", { name: "Request progress", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "View requests", exact: true }).click();
    expect(await details.evaluate((element) => element.clientHeight)).toBeGreaterThan(100);
    await expect(page.getByRole("article", { name: "Activate Deployment Owners", exact: true })).toBeInViewport();
    await page.getByRole("article", { name: "Activate Application Support", exact: true }).scrollIntoViewIfNeeded();
    await expect(page.getByRole("article", { name: "Activate Application Support", exact: true })).toBeInViewport();
    await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: info.outputPath(`request-results-${darkMode ? "dark" : "light"}.png`) });
  });
}

test("a completed result is shown once after popup closure without removing its history", async () => {
  let page = await popup(); await start(page, [items[0]]); await page.close(); await release();
  await expect.poll(async () => (await evidence()).operations[0].state).toBe("complete");
  page = await popup();
  await expect(page.getByRole("region", { name: "Requests", exact: true })).toContainText("1 new result");
  // A collapsed strip does not count as reading the actual result.
  await page.close(); page = await popup();
  await expect(page.getByRole("button", { name: "View requests", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "View requests", exact: true }).click();
  await expect(page.getByRole("region", { name: "Requests", exact: true }).getByText("Active", { exact: true })).toBeInViewport();
  await expect.poll(async () => Boolean((await evidence()).operations[0].popupResultSeenAt)).toBe(true);
  await page.close(); await context.close(); await launch(); await seed(true); page = await popup();
  await expect(page.getByRole("region", { name: "Requests", exact: true })).toHaveCount(0);
  expect((await evidence()).operations).toHaveLength(1);
  const history = await worker.evaluate(async () => (await chrome.storage.local.get("quickPimRequests.v1"))["quickPimRequests.v1"]);
  expect(history.requests[0].operationId).toBe((await evidence()).operations[0].id);
  expect(history.requests).toHaveLength(1);
  await start(page, [items[1]]);
  await page.getByRole("button", { name: "View requests", exact: true }).click();
  await expect(page.getByRole("article", { name: "Activate Deployment Owners", exact: true })).toBeVisible();
  await expect(page.getByRole("article", { name: "Activate Application Support", exact: true })).toHaveCount(0);
  const settings = await context.newPage(); await settings.setViewportSize({ width: 1000, height: 720 });
  await settings.goto(`chrome-extension://${extensionId}/settings.html#activity`);
  await settings.getByRole("region", { name: "Requests", exact: true }).getByRole("button", { name: "View requests", exact: true }).click();
  await settings.getByRole("article", { name: "Activate Application Support", exact: true }).scrollIntoViewIfNeeded();
  await expect(settings.getByRole("article", { name: "Activate Application Support", exact: true })).toBeInViewport();
  await settings.close();
});

test("starting another request clears a viewed completion without hiding pending work", async ({}, info) => {
  const page = await popup(); await start(page, [items[0]]);
  await page.getByRole("button", { name: "View requests", exact: true }).click();
  await expect(page.getByText("Submitting to Microsoft", { exact: true })).toBeInViewport();
  await release();
  await expect(page.getByRole("region", { name: "Requests", exact: true }).getByText("Active", { exact: true })).toBeInViewport();
  await expect.poll(async () => Boolean((await evidence()).operations[0].popupResultSeenAt)).toBe(true);
  await worker.evaluate(async () => {
    const data = await chrome.storage.local.get("requestTestHarness");
    await chrome.storage.local.set({ requestTestHarness: { ...data.requestTestHarness, hold: true } });
  });
  await start(page, [items[1]]);
  await expect(page.getByRole("article", { name: "Activate Application Support", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Hide requests", exact: true }).click();
  await page.getByRole("button", { name: "View requests", exact: true }).click();
  await expect(page.getByRole("article", { name: "Activate Application Support", exact: true })).toHaveCount(0);
  await expect(page.getByRole("article", { name: "Activate Deployment Owners", exact: true })).toBeInViewport();
  await expect(page.getByRole("region", { name: "Requests", exact: true })).toContainText("request in progress");
  await page.screenshot({ path: info.outputPath("only-running-request.png") });
  expect((await evidence()).operations).toHaveLength(2);
});

test("completed results below the scroll fold are not consumed until viewed", async () => {
  let page = await popup();
  for (const item of items.slice(0, 3)) await start(page, [item]);
  await page.close(); await release();
  await expect.poll(async () => (await evidence()).operations.filter((op) => op.state === "complete").length).toBe(3);
  page = await popup(); await page.getByRole("button", { name: "View requests", exact: true }).click();
  await expect.poll(async () => (await evidence()).operations.filter((op) => op.popupResultSeenAt).length).toBe(1);
  await page.close(); page = await popup();
  await expect(page.getByRole("region", { name: "Requests", exact: true })).toContainText("2 new results");
  expect((await evidence()).operations).toHaveLength(3);
});

async function seedUiResult(selected = [items[0]], failLast = false) {
  const now = Date.now();
  const operation: RequestOperationRecord = {
    id: "ui_audit_result_1234", action: "activate", state: "complete", itemIds: selected.map((item) => item.id), targets: [...new Set(selected.map((item) => item.type))],
    tenantId: tenant, principalId: principal, startedAt: now, updatedAt: now, durationHours: 4, justification: reason,
    items: createRequestOperationItems(selected, now).map((item, index) => ({ ...item, state: "terminal", result: { itemId: item.itemId, itemName: item.itemName, success: !(failLast && index === selected.length - 1), requestStatus: failLast && index === selected.length - 1 ? "failed" : "active", ...(failLast && index === selected.length - 1 ? { error: "The final item was denied by policy." } : {}) } }))
  };
  await worker.evaluate(async (operation) => chrome.storage.local.set({ "quickPimRequestOperations.v2": [operation] }), operation);
  return operation;
}
async function afterPaint(page: Page) { await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))); }

test("audit: a bundle is unread until every final outcome has been visible", async ({}, info) => {
  const selected = Array.from({ length: 12 }, (_, index) => ({ ...items[0], id: `pimGroup:audit-${index}:member`, groupId: `audit-${index}`, displayName: `Audit bundle item ${index + 1}` }));
  await seedUiResult(selected, true);
  const page = await popup(); await page.getByRole("button", { name: "View requests", exact: true }).click();
  const labels = page.locator(".request-result-label"); await expect(labels.first()).toBeInViewport({ ratio: 1 }); await afterPaint(page);
  await page.screenshot({ path: info.outputPath("bundle-first-outcome.png") });
  expect((await evidence()).operations[0].popupResultSeenAt).toBeUndefined();
  for (const label of await labels.all()) { await label.scrollIntoViewIfNeeded(); await afterPaint(page); }
  await expect(labels.last()).toHaveText("Failed");
  await expect.poll(async () => Boolean((await evidence()).operations[0].popupResultSeenAt)).toBe(true);
  await page.screenshot({ path: info.outputPath("bundle-final-outcome.png") });
});

test("audit: new work does not remove a result whose parameters are being inspected", async ({}, info) => {
  await seedUiResult(); const page = await popup(); await page.getByRole("button", { name: "View requests", exact: true }).click();
  await expect.poll(async () => Boolean((await evidence()).operations[0].popupResultSeenAt)).toBe(true);
  const card = page.getByRole("article", { name: "Activate Application Support", exact: true });
  await card.getByText("Parameters and result", { exact: true }).click(); await card.locator("summary").focus();
  await start(page, [items[1]]);
  await expect(card.locator("details")).toHaveAttribute("open", ""); await expect(card.locator("summary")).toBeFocused();
  await page.screenshot({ path: info.outputPath("inspection-preserved.png") });
});

test("audit: dismissing the last result preserves keyboard focus and the next request starts collapsed", async () => {
  await seedUiResult(); const page = await popup(); await page.getByRole("button", { name: "View requests", exact: true }).click();
  const dismiss = page.getByRole("button", { name: "Dismiss result", exact: true }); await dismiss.focus(); await page.keyboard.press("Enter");
  await expect(page.getByRole("region", { name: "Requests", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeFocused();
  await start(page, [items[1]]);
  await expect(page.getByRole("button", { name: "View requests", exact: true })).toHaveAttribute("aria-expanded", "false");
});

test("audit: status storage failures are visible without a cached request and recover without stale errors", async () => {
  const page = await context.newPage();
  await page.addInitScript(() => {
    const storage = chrome.storage.local as unknown as { get: (key: unknown) => Promise<Record<string, unknown>> };
    const original = storage.get.bind(storage);
    Object.assign(window, { restoreAuditRead: () => { storage.get = original; } });
    storage.get = async (key) => { if (["quickPimRequestOperations.v2", "quickPimRequests.v1"].includes(String(key))) throw new Error("Synthetic read failure"); return original(key); };
  });
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(page.getByRole("region", { name: "Requests", exact: true })).toContainText("temporarily unavailable");
  await page.evaluate(() => (window as any).restoreAuditRead());
  await page.getByRole("button", { name: "Retry request status", exact: true }).click();
  await expect(page.getByRole("region", { name: "Requests", exact: true })).toHaveCount(0);
  await start(page, [items[1]]);
  await expect(page.getByRole("region", { name: "Requests", exact: true })).not.toContainText("unavailable");
});

test("audit: failed result acknowledgement can be retried without losing history or leaving stale messages", async () => {
  await seedUiResult(); const page = await context.newPage();
  await page.addInitScript(() => {
    const storage = chrome.storage.local as unknown as { set: (values: Record<string, unknown>) => Promise<void> };
    const original = storage.set.bind(storage);
    Object.assign(window, { restoreAuditWrite: () => { storage.set = original; } });
    storage.set = async (values) => {
      if ((values["quickPimRequestOperations.v2"] as Array<{ popupResultSeenAt?: number }> | undefined)?.some((op) => op.popupResultSeenAt)) throw new Error("Synthetic acknowledgement failure");
      return original(values);
    };
  });
  await page.goto(`chrome-extension://${extensionId}/popup.html`); await page.getByRole("button", { name: "View requests", exact: true }).click();
  await expect(page.getByRole("region", { name: "Requests", exact: true })).toContainText("Could not remember");
  expect((await evidence()).operations[0].popupResultSeenAt).toBeUndefined();
  await page.evaluate(() => (window as any).restoreAuditWrite());
  await page.getByRole("button", { name: "Dismiss result", exact: true }).click();
  await expect(page.getByRole("region", { name: "Requests", exact: true })).toHaveCount(0);
  expect((await evidence()).operations).toHaveLength(1);
  await start(page, [items[1]]); await page.getByRole("button", { name: "View requests", exact: true }).click();
  await expect(page.getByRole("region", { name: "Requests", exact: true })).not.toContainText("Could not remember");
});

test("audit: changing accounts resets expanded request details and preserves account boundaries", async () => {
  await seedUiResult(); const page = await popup(); await page.getByRole("button", { name: "View requests", exact: true }).click();
  const other = "33333333-3333-4333-8333-333333333333", now = Date.now();
  const op: RequestOperationRecord = { id: "audit_other_account", action: "activate", state: "running", tenantId: tenant, principalId: other, itemIds: [items[1].id], targets: ["pimGroup"], startedAt: now, updatedAt: now, items: createRequestOperationItems([{ ...items[1], principalId: other }], now) };
  await worker.evaluate(async ({ other, op }) => {
    const tokens = await chrome.storage.session.get(["graphToken", "azureManagementToken"]);
    const change = (token: string) => { const parts = token.split("."); const claims = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"))); claims.oid = other; claims.preferred_username = "other@example.invalid"; parts[1] = btoa(JSON.stringify(claims)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); return parts.join("."); };
    const data = await chrome.storage.local.get("quickPimRequestOperations.v2");
    await chrome.storage.local.set({ "quickPimRequestOperations.v2": [...data["quickPimRequestOperations.v2"], op] });
    await chrome.storage.session.set({ graphToken: change(tokens.graphToken), azureManagementToken: change(tokens.azureManagementToken), tokenTimestamp: Date.now(), azureManagementTokenTimestamp: Date.now() });
  }, { other, op });
  await expect(page.getByRole("button", { name: "View requests", exact: true })).toHaveAttribute("aria-expanded", "false");
  await page.getByRole("button", { name: "View requests", exact: true }).click();
  await expect(page.getByRole("article", { name: "Activate Application Support", exact: true })).toHaveCount(0);
  await expect(page.getByRole("article", { name: "Activate Deployment Owners", exact: true })).toBeVisible();
});

test("audit: request details, queued disable retries and banners keep footer controls usable", async ({}, info) => {
  await seedUiResult(); const now = Date.now();
  const active = { ...items[1], status: "active", activeAssignmentType: "activated", activeFrom: new Date(now - 10_000).toISOString(), activeUntil: new Date(now + 3600_000).toISOString(), assignmentScheduleId: "audit-schedule", assignmentScheduleInstanceId: "audit-instance" };
  await worker.evaluate(async ({ active, now }) => chrome.storage.local.set({ "quickPimDeactivationRetries.v1": [{ id: "audit-retry", item: active, justification: "Incorrect role selected for the approved task", ticketInfo: {}, state: "queued", createdAt: now, updatedAt: now, retryAt: now + 290_000 }] }), { active, now });
  const page = await popup(); await page.getByRole("button", { name: "View requests", exact: true }).click();
  await expect(page.getByRole("button", { name: "Cancel retry", exact: true })).toBeInViewport();
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeInViewport({ ratio: 1 });
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true);
  await page.screenshot({ path: info.outputPath("stacked-notices.png") });
  await page.getByRole("tab", { name: "PIM Groups", exact: true }).click();
  await page.locator(".role-row").filter({ hasText: items[1].displayName }).locator('input[type="checkbox"]').check();
  await page.getByRole("button", { name: /Continue/ }).click();
  await expect(page.getByRole("button", { name: "Activate 1 selected", exact: true })).toBeInViewport({ ratio: 1 });
  await page.getByRole("button", { name: "Back to role selection", exact: true }).click();
  await page.getByRole("button", { name: "Cancel retry", exact: true }).click();
  await expect(page.getByRole("button", { name: "Cancel retry", exact: true })).toHaveCount(0);
});

test("audit: long parameters, dark mode, reduced motion and rapid disclosure toggles remain usable", async ({}, info) => {
  const op = await seedUiResult([{ ...items[0], displayName: "LongRole".repeat(40), scopeLabel: "LongScope".repeat(35) }]);
  op.justification = "Detailed justification ".repeat(40); op.ticketInfo = { ticketSystem: "ServiceDesk".repeat(10), ticketNumber: "INC".repeat(40) };
  await worker.evaluate(async (op) => {
    const data = await chrome.storage.local.get("quickPimSettings.v1");
    await chrome.storage.local.set({ "quickPimRequestOperations.v2": [op], "quickPimSettings.v1": { ...data["quickPimSettings.v1"], preferences: { ...data["quickPimSettings.v1"].preferences, darkMode: true } } });
  }, op);
  const page = await popup(); await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "View requests", exact: true }).click(); await page.locator(".request-activity-card summary").click();
  const pane = page.locator(".request-activity-details"); expect(await pane.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: info.outputPath("long-parameters-dark.png") });
  await start(page, [items[1]]);
  for (let index = 0; index < 8; index++) await page.getByRole("button", { name: index % 2 ? "View requests" : "Hide requests", exact: true }).click();
  await expect(page.getByRole("progressbar", { name: "Request progress", exact: true })).toBeInViewport({ ratio: 1 });
  await expect(page.locator(".request-activity-progress > span")).toHaveCSS("animation-name", "none");
});

function installOfflineMicrosoft() {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  let serial = Promise.resolve();
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const write = ["POST", "PUT"].includes(init?.method || "") && /(?:assignmentScheduleRequests|roleAssignmentScheduleRequests)/i.test(url.pathname);
    if (write) {
      if (body.isValidationOnly) return json({ status: "Validated" });
      let id = "";
      serial = serial.then(async () => {
        const { requestTestHarness: harness } = await chrome.storage.local.get("requestTestHarness");
        if (!harness) throw new Error("Offline test has no request configuration");
        id = `request-${harness.writes.length + 1}`;
        harness.writes.push({ ...body, testId: id, endpoint: url.pathname });
        await chrome.storage.local.set({ requestTestHarness: harness });
      }); await serial;
      let harness = (await chrome.storage.local.get("requestTestHarness")).requestTestHarness;
      while (harness.hold) { await new Promise((resolve) => setTimeout(resolve, 25)); harness = (await chrome.storage.local.get("requestTestHarness")).requestTestHarness; }
      if (harness.failGroup && body.groupId === harness.failGroup) return json({ error: { code: "Denied", message: "The test policy denied this request." } }, 403);
      const status = body.action === "selfDeactivate" ? "Revoked" : harness.approval ? "PendingApproval" : "Provisioned";
      return json({ id, ...body, status, ...(body.properties ? { properties: { ...body.properties, status } } : {}) }, 201);
    }
    if (["graph.microsoft.com", "management.azure.com"].includes(url.hostname)) {
      const harness = (await chrome.storage.local.get("requestTestHarness")).requestTestHarness;
      if (url.pathname.includes("/privilegedAccess/group/eligibilityScheduleInstances")) return json({ value: (harness?.items || []).filter((item: ActivationItem) => item.type === "pimGroup").map((item: any) => ({ id: `eligibility-${item.groupId}`, groupId: item.groupId, principalId: item.principalId, accessId: item.accessId })) });
      if (url.pathname.endsWith("/$batch")) return json({ responses: (body.requests || []).map((request: { id: string; url: string }) => ({ id: request.id, status: 200, body: { id: "group-a", displayName: request.url.includes("group-b") ? "Deployment Owners" : "Application Support", value: [] } })) });
      return json({ value: [] });
    }
    if (url.hostname === "api.github.com") return json([]);
    throw new Error(`Unexpected offline request ${url.origin}${url.pathname}`);
  };
}
