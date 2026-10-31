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
  const snapshot = await evidence(); expect(snapshot.operations[0].id).toBe(originalId); expect(snapshot.operations[0].justification).toBe(reason);
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
