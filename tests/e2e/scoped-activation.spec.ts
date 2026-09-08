import { chromium, expect, test, type BrowserContext, type Worker } from "@playwright/test";
import path from "node:path";
import type { ActivationResponse, DirectoryRoleItem, TrackedPimRequestStore } from "../../src/lib/types";

interface ActivationHarness {
  writes: Array<Record<string, unknown>>;
  unexpectedRequests: string[];
}

let context: BrowserContext;
let worker: Worker;
let extensionId: string;

test.beforeEach(async () => {
  const extensionPath = path.resolve(process.env.QUICKPIM_E2E_EXTENSION_DIR || "dist");
  context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: true,
    offline: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });
  worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  extensionId = new URL(worker.url()).host;
});

test.afterEach(async () => {
  await context.close();
});

for (const scenario of [
  { name: "activates a restricted AU while the tenant-wide role is active", scope: "/administrativeUnits/restricted-au", rejectActual: false },
  { name: "activates the tenant-wide role while a restricted AU role is active", scope: "/", rejectActual: false },
  { name: "preserves a genuine duplicate rejection from the actual scoped activation", scope: "/administrativeUnits/restricted-au", rejectActual: true }
]) {
  test(scenario.name, async () => {
    const item = await installHarness(scenario.scope, scenario.rejectActual);
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    await expect(page.locator(".role-row")).toHaveCount(2);
    await expect(page.locator(".role-row").filter({ hasText: item.scopeLabel })).toContainText("Groups Administrator");

    const response = await page.evaluate(async (selectedItem) => chrome.runtime.sendMessage({
      action: "activateItems",
      operationId: "scoped-activation-regression",
      items: [selectedItem],
      durationHours: 1,
      justification: "Maintain groups in the selected administrative scope"
    }), item) as { success: boolean; data: ActivationResponse; error?: string };

    expect(response.success, response.error).toBe(true);
    const evidence = await worker.evaluate(async () => {
      const harness = (globalThis as typeof globalThis & { scopedActivationHarness: ActivationHarness }).scopedActivationHarness;
      const stored = await chrome.storage.local.get("quickPimRequests.v1");
      return { ...harness, tracked: stored["quickPimRequests.v1"] as TrackedPimRequestStore | undefined };
    });
    expect(evidence.unexpectedRequests).toEqual([]);
    expect(evidence.writes).toHaveLength(2);
    expect(evidence.writes[0]).toMatchObject({
      action: "selfActivate",
      principalId: item.principalId,
      roleDefinitionId: item.roleDefinitionId,
      directoryScopeId: scenario.scope,
      isValidationOnly: true
    });
    const { isValidationOnly, ...validatedBody } = evidence.writes[0];
    expect(isValidationOnly).toBe(true);
    expect(evidence.writes[1]).toEqual(validatedBody);

    if (scenario.rejectActual) {
      expect(response.data.success).toBe(false);
      expect(response.data.errors).toEqual([expect.objectContaining({
        itemId: item.id,
        success: false,
        error: "The Role assignment already exists."
      })]);
      expect(evidence.tracked?.requests || []).toHaveLength(0);
    } else {
      expect(response.data.success).toBe(true);
      expect(response.data.results).toEqual([expect.objectContaining({
        itemId: item.id,
        success: true,
        requestId: "scoped-request-accepted"
      })]);
      expect(evidence.tracked?.requests).toEqual([expect.objectContaining({
        requestId: "scoped-request-accepted",
        roleDefinitionId: item.roleDefinitionId,
        directoryScopeId: scenario.scope,
        tenantId: item.tenantId,
        principalId: item.principalId,
        status: "active"
      })]);
    }
  });
}

async function installHarness(scope: string, rejectActual: boolean): Promise<DirectoryRoleItem> {
  return worker.evaluate(async ({ targetScope, rejectWrite }) => {
    const now = Date.now();
    const item: DirectoryRoleItem = {
      id: `directoryRole:groups-admin:${targetScope}`,
      type: "directoryRole",
      tenantId: "tenant-scoped-test",
      principalId: "principal-scoped-test",
      roleDefinitionId: "groups-admin",
      directoryScopeId: targetScope,
      sourceName: "Groups Administrator",
      displayName: "Groups Administrator",
      scopeLabel: targetScope === "/" ? "Tenant" : "Restricted AU",
      status: "eligible",
      activationPolicyState: "ready",
      activationRequirements: { justification: true, maxDurationHours: 4 }
    };
    const otherScope = targetScope === "/" ? "/administrativeUnits/restricted-au" : "/";
    const active = {
      ...item,
      id: `directoryRole:groups-admin:${otherScope}`,
      directoryScopeId: otherScope,
      scopeLabel: otherScope === "/" ? "Tenant" : "Restricted AU",
      status: "active",
      activeAssignmentType: "activated",
      assignmentScheduleId: "other-scope-schedule",
      activeUntil: new Date(now + 2 * 60 * 60_000).toISOString()
    };
    const harness: ActivationHarness = { writes: [], unexpectedRequests: [] };
    (globalThis as typeof globalThis & { scopedActivationHarness: ActivationHarness }).scopedActivationHarness = harness;
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" }
    });
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const parsed = new URL(url);
      if (parsed.origin === "https://graph.microsoft.com" && init?.method === "POST"
        && parsed.pathname === "/v1.0/roleManagement/directory/roleAssignmentScheduleRequests") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        harness.writes.push(body);
        if (body.isValidationOnly === true || rejectWrite) {
          return json({ error: { code: "RoleAssignmentExists", message: "The Role assignment already exists." } }, 400);
        }
        return json({
          ...body,
          id: "scoped-request-accepted",
          status: "Provisioned",
          scheduleInfo: { expiration: { endDateTime: new Date(now + 60 * 60_000).toISOString() } }
        }, 201);
      }
      if (parsed.origin === "https://graph.microsoft.com" && (!init?.method || init.method === "GET")) {
        if (parsed.pathname.includes("roleEligibilityScheduleInstances")) return json({ value: [item] });
        if (parsed.pathname.includes("roleAssignmentScheduleInstances")) return json({ value: [active] });
        return json({ value: [] });
      }
      harness.unexpectedRequests.push(`${init?.method || "GET"} ${parsed.origin}${parsed.pathname}`);
      throw new Error("Unexpected request in offline scoped activation test");
    };
    const grantedScope = "RoleManagement.ReadWrite.Directory";
    const encode = (value: Record<string, unknown>) => btoa(JSON.stringify(value))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    const token = `${encode({ alg: "none" })}.${encode({
      aud: "https://graph.microsoft.com",
      exp: Math.floor(now / 1000) + 3600,
      tid: item.tenantId,
      oid: item.principalId,
      scp: grantedScope
    })}.signature`;
    await chrome.storage.session.set({ graphToken: token, tokenTimestamp: now, tokenSource: "portal" });
    const cacheKey = `graphDirectory:${item.tenantId}:${item.principalId}:${grantedScope}:generation=${now}`;
    await chrome.storage.local.set({
      "quickPimSettings.v1": {
        preferences: { enabledFeatures: ["directoryRole"], autoEnabledFeaturesInitialized: true }
      },
      "quickPimDataCache.v1": {
        eligibleByTarget: { directoryRole: { items: [item], errors: [], fetchedAt: now, cacheKey } },
        activeByTarget: { directoryRole: { items: [active], errors: [], fetchedAt: now, cacheKey } }
      }
    });
    return item;
  }, { targetScope: scope, rejectWrite: rejectActual });
}
