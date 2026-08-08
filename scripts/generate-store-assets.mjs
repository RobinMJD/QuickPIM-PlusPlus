import { chromium } from "@playwright/test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const DIST_DIR = resolve("dist");
const OUTPUT_DIR = resolve("store/assets");
const DOCS_DIR = resolve("docs/images");
const LOGO_DATA_URL = toDataUrl(readFileSync("public/img/QuickPim128.png"), "image/png");

const SCREENSHOTS = [
  {
    fileName: "screenshot-01-popup-roles-1280x800.png",
    source: "roles",
    eyebrow: "FIND ACCESS FAST",
    title: "Your eligible roles, ready in one place.",
    description: "Search Entra roles, PIM groups, and Azure roles without navigating between portal blades."
  },
  {
    fileName: "screenshot-02-popup-activation-1280x800.png",
    source: "activation",
    eyebrow: "POLICY-AWARE ACTIVATION",
    title: "Review only what the role requires.",
    description: "QuickPIM++ adapts duration and justification controls to the selected role policy."
  },
  {
    fileName: "screenshot-03-popup-bundles-1280x800.png",
    source: "bundles",
    eyebrow: "REPEATABLE WORKFLOWS",
    title: "Activate related access as a bundle.",
    description: "Save common role and group combinations with a duration and specific justification."
  },
  {
    fileName: "screenshot-04-popup-active-1280x800.png",
    source: "active",
    eyebrow: "LIVE PIM STATUS",
    title: "Know exactly when active access ends.",
    description: "Filter current PIM activations, follow the countdown, or disable access before expiry."
  }
];

if (!existsSync(resolve(DIST_DIR, "manifest.json"))) {
  throw new Error("Build dist/ before generating Store assets (npm run build).");
}

mkdirSync(OUTPUT_DIR, { recursive: true });
mkdirSync(DOCS_DIR, { recursive: true });
removeObsoleteAssets();

const compositor = await chromium.launch({ headless: true });

try {
  const popupCaptures = {};
  for (const screenshot of SCREENSHOTS) {
    popupCaptures[screenshot.source] = await capturePopup(screenshot.source);
    await renderShowcase(compositor, screenshot, popupCaptures[screenshot.source]);
  }

  const settingsCapture = await captureSettings();
  await renderExactScreenshot(compositor, "screenshot-05-settings-appearance-1280x800.png", settingsCapture);
  await renderAsset(compositor, "icon-300.png", 300, 300, `
    <main class="icon"><img src="${LOGO_DATA_URL}" alt=""></main>
  `, assetCss());
  await renderAsset(
    compositor,
    "small-promo-440x280.png",
    440,
    280,
    smallPromoMarkup(popupCaptures.roles),
    promoCss()
  );
  await renderAsset(
    compositor,
    "large-promo-1400x560.png",
    1400,
    560,
    largePromoMarkup(popupCaptures.roles),
    promoCss()
  );

  for (const fileName of [
    ...SCREENSHOTS.map((screenshot) => screenshot.fileName),
    "screenshot-05-settings-appearance-1280x800.png"
  ]) {
    copyFileSync(resolve(OUTPUT_DIR, fileName), resolve(DOCS_DIR, fileName));
  }
} finally {
  await compositor.close();
}

console.log(`Generated popup-first Chrome and Microsoft Edge listing assets in ${OUTPUT_DIR}.`);

async function capturePopup(state) {
  return withIsolatedExtensionPage("popup.html", { width: 520, height: 600 }, async (page) => {
    await page.getByRole("heading", { name: "QuickPIM++" }).waitFor();
    await page.locator(".loading-state, .smart-progress-panel").waitFor({ state: "hidden", timeout: 15_000 }).catch(() => undefined);

    if (state !== "bundles") {
      await page.getByRole("tab", { name: "Entra Roles" }).click();
    }

    if (state === "activation") {
      await page.locator(".role-row.selectable").filter({ hasText: "Application Administrator" }).click();
      await page.getByRole("button", { name: /Continue with 1 selected/i }).click();
      await page.locator(".justification-textarea").fill("Complete approved application access maintenance.");
    } else if (state === "bundles") {
      await page.getByRole("tab", { name: "Bundles" }).click();
    } else if (state === "active") {
      await page.getByRole("switch", { name: "Show active PIM roles only" }).click();
    }

    await page.locator(".app-shell").waitFor();
    return page.screenshot({ animations: "disabled" });
  });
}

async function captureSettings() {
  return withIsolatedExtensionPage("settings.html#appearance", { width: 1280, height: 800 }, async (page) => {
    await page.getByRole("heading", { name: "Popup & Appearance" }).waitFor();
    await page.locator(".settings-layout").waitFor();
    return page.screenshot({ animations: "disabled" });
  });
}

async function withIsolatedExtensionPage(route, viewport, capture) {
  const profileDir = mkdtempSync(join(tmpdir(), "quickpim-store-assets-"));
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: "chromium",
    headless: true,
    viewport,
    deviceScaleFactor: 2,
    args: [`--disable-extensions-except=${DIST_DIR}`, `--load-extension=${DIST_DIR}`]
  });
  try {
    let worker = context.serviceWorkers()[0];
    if (!worker) worker = await context.waitForEvent("serviceworker");
    const extensionId = new URL(worker.url()).host;
    const page = await context.newPage();
    await page.setViewportSize(viewport);
    await page.goto(`chrome-extension://${extensionId}/${route}`);
    await seedDemoState(page);
    await page.reload();
    return await capture(page);
  } finally {
    await context.close();
    rmSync(profileDir, { recursive: true, force: true });
  }
}

async function seedDemoState(page) {
  await page.evaluate(async () => {
    const now = Date.now();
    const tenantId = "contoso-demo-tenant";
    const principalId = "contoso-demo-admin";
    const principalName = "alex.wilber@contoso.onmicrosoft.com";
    const encode = (value) => btoa(JSON.stringify(value))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
    const token = (aud, scopes = "") => `${encode({ alg: "none" })}.${encode({
      aud,
      exp: Math.floor(now / 1000) + 3600,
      tid: tenantId,
      oid: principalId,
      preferred_username: principalName,
      ...(scopes ? { scp: scopes } : {})
    })}.signature`;

    const directoryScopes = "RoleAssignmentSchedule.ReadWrite.Directory RoleEligibilitySchedule.Read.Directory";
    const groupScopes = "PrivilegedAssignmentSchedule.ReadWrite.AzureADGroup PrivilegedEligibilitySchedule.Read.AzureADGroup";
    const directoryCacheKey = `graphDirectory:${tenantId}:${principalId}:${directoryScopes.split(" ").sort().join(",")}`;
    const groupCacheKey = `graphPimGroup:${tenantId}:${principalId}:${groupScopes.split(" ").sort().join(",")}`;
    const azureCacheKey = `azure:${tenantId}:${principalId}:`;

    const directoryItem = (key, name, options = {}) => ({
      id: `directoryRole:${key}:/`,
      type: "directoryRole",
      sourceName: name,
      displayName: name,
      principalId,
      roleDefinitionId: key,
      directoryScopeId: "/",
      scopeLabel: "Tenant",
      status: "eligible",
      activationPolicyState: "ready",
      activationRequirements: {
        justification: true,
        ticket: false,
        approval: Boolean(options.approval),
        maxDurationHours: options.maxDurationHours || 4
      },
      isPrivileged: Boolean(options.privileged)
    });
    const pimGroupItem = (key, name, options = {}) => ({
      id: `pimGroup:${key}:member`,
      type: "pimGroup",
      sourceName: name,
      displayName: name,
      principalId,
      groupId: key,
      accessId: "member",
      memberType: "direct",
      scopeLabel: "Member",
      status: "eligible",
      activationPolicyState: "ready",
      activationRequirements: {
        justification: true,
        ticket: false,
        approval: Boolean(options.approval),
        maxDurationHours: options.maxDurationHours || 4
      }
    });
    const azureItem = (key, name, scopeLabel) => ({
      id: `azureRole:${key}:/subscriptions/demo-subscription`,
      type: "azureRole",
      sourceName: name,
      displayName: name,
      principalId,
      roleDefinitionId: `/subscriptions/demo-subscription/providers/Microsoft.Authorization/roleDefinitions/${key}`,
      scope: "/subscriptions/demo-subscription",
      subscriptionId: "demo-subscription",
      subscriptionName: "Contoso Production",
      roleEligibilityScheduleId: `eligibility-${key}`,
      scopeLabel,
      status: "eligible",
      activationPolicyState: "ready",
      activationRequirements: {
        justification: true,
        ticket: false,
        approval: false,
        maxDurationHours: 8
      }
    });

    const directoryItems = [
      directoryItem("global-admin", "Global Administrator", { privileged: true, approval: true, maxDurationHours: 2 }),
      directoryItem("application-admin", "Application Administrator", { privileged: true }),
      directoryItem("conditional-access-admin", "Conditional Access Administrator", { privileged: true }),
      directoryItem("exchange-admin", "Exchange Administrator", { privileged: true }),
      directoryItem("groups-admin", "Groups Administrator"),
      directoryItem("global-reader", "Global Reader", { maxDurationHours: 8 })
    ];
    const pimGroupItems = [
      pimGroupItem("identity-operations", "Identity Operations - PIM"),
      pimGroupItem("intune-administrators", "Intune Administrators - PIM", { approval: true }),
      pimGroupItem("access-package-reviewers", "Access Package Reviewers")
    ];
    const azureItems = [
      azureItem("contributor", "Contributor", "Contoso Production"),
      azureItem("reader", "Reader", "Shared Services"),
      azureItem("user-access-admin", "User Access Administrator", "Identity Platform")
    ];
    const activeItem = (roleDefinitionId, remainingMs) => ({
      ...directoryItems.find((item) => item.roleDefinitionId === roleDefinitionId),
      status: "active",
      activeAssignmentType: "activated",
      activeUntil: new Date(now + remainingMs).toISOString(),
      assignmentScheduleId: `schedule-${roleDefinitionId}`,
      assignmentScheduleInstanceId: `schedule-instance-${roleDefinitionId}`
    });
    const activeDirectoryItems = [
      activeItem("global-reader", 2 * 60 * 60 * 1000 + 17 * 60 * 1000),
      activeItem("exchange-admin", 45 * 60 * 1000 + 12 * 1000),
      activeItem("groups-admin", 6 * 60 * 1000 + 38 * 1000)
    ];

    const entry = (items, cacheKey) => ({
      items,
      errors: [],
      fetchedAt: now,
      refreshStartedAt: now - 250,
      cacheKey,
      diagnostics: [{
        target: items[0]?.type || "directoryRole",
        success: true,
        checkedAt: new Date(now).toISOString(),
        operation: "eligible",
        endpointLabel: "Microsoft PIM",
        fromCache: false
      }]
    });
    const emptyEntry = (target, cacheKey) => ({
      items: [],
      errors: [],
      fetchedAt: now,
      refreshStartedAt: now - 250,
      cacheKey,
      diagnostics: [{
        target,
        success: true,
        checkedAt: new Date(now).toISOString(),
        operation: "active",
        endpointLabel: "Microsoft PIM",
        fromCache: false
      }]
    });

    await Promise.all([chrome.storage.local.clear(), chrome.storage.session.clear()]);
    await chrome.storage.session.set({
      graphToken: token("https://graph.microsoft.com", `${directoryScopes} ${groupScopes}`),
      tokenTimestamp: now,
      tokenSource: "portal",
      graphDirectoryRoleToken: token("https://graph.microsoft.com", directoryScopes),
      graphDirectoryRoleTokenTimestamp: now,
      graphDirectoryRoleTokenSource: "portal",
      graphPimGroupToken: token("https://graph.microsoft.com", groupScopes),
      graphPimGroupTokenTimestamp: now,
      graphPimGroupTokenSource: "portal",
      azureManagementToken: token("https://management.azure.com/"),
      azureManagementTokenTimestamp: now,
      azureManagementTokenSource: "portal"
    });
    await chrome.storage.local.set({
      "quickPimSettings.v1": {
        version: 2,
        aliasesByItemId: {},
        favoriteItemIds: ["directoryRole:application-admin:/", "directoryRole:conditional-access-admin:/"],
        savedJustifications: ["Complete approved application access maintenance."],
        recentJustifications: [
          "Complete approved application access maintenance.",
          "Investigate the identity service incident."
        ],
        bundles: [
          {
            id: "bundle:application-release",
            name: "Application release administration",
            itemIds: ["directoryRole:application-admin:/", "pimGroup:identity-operations:member"],
            defaultDurationHours: 2,
            defaultJustification: "Complete the approved production release."
          },
          {
            id: "bundle:identity-review",
            name: "Identity access review",
            itemIds: ["directoryRole:global-reader:/", "pimGroup:access-package-reviewers:member"],
            defaultDurationHours: 1,
            defaultJustification: "Review privileged identity access assignments."
          }
        ],
        usageStatsByItemId: {
          "directoryRole:application-admin:/": { activationCount: 6, lastUsedAt: new Date(now - 86400000).toISOString() },
          "directoryRole:conditional-access-admin:/": { activationCount: 3, lastUsedAt: new Date(now - 172800000).toISOString() }
        },
        activityHistory: [],
        activationHistory: [],
        preferences: {
          defaultDurationHours: 0.5,
          defaultExtensionDurationHours: 0.5,
          defaultSort: "name",
          defaultSortDirection: "ascending",
          recentJustificationLimit: 8,
          activityHistoryLimit: 100,
          darkMode: false,
          showAssignedRoles: false,
          showRemainingActivationTime: true,
          showActivationCounters: false,
          showEnablementDetails: false,
          showLastEnablementDate: false,
          backgroundPreRefreshEnabled: true,
          requestNotificationsEnabled: false,
          expiryReminderMinutes: 15,
          enabledFeatures: ["directoryRole", "pimGroup", "azureRole", "bundles"],
          autoEnabledFeaturesInitialized: true,
          permissionWarningIgnored: false
        }
      },
      "quickPimDataCache.v1": {
        eligibleByTarget: {
          directoryRole: entry(directoryItems, directoryCacheKey),
          pimGroup: entry(pimGroupItems, groupCacheKey),
          azureRole: entry(azureItems, azureCacheKey)
        },
        activeByTarget: {
          directoryRole: entry(activeDirectoryItems, directoryCacheKey),
          pimGroup: emptyEntry("pimGroup", groupCacheKey),
          azureRole: emptyEntry("azureRole", azureCacheKey)
        }
      }
    });
  });
}

async function renderShowcase(browser, screenshot, popupCapture) {
  const popupDataUrl = toDataUrl(popupCapture, "image/png");
  await renderAsset(browser, screenshot.fileName, 1280, 800, `
    <main class="showcase">
      <section class="showcase-copy">
        <div class="showcase-brand"><img src="${LOGO_DATA_URL}" alt=""><span>QuickPIM++</span></div>
        <p class="eyebrow">${screenshot.eyebrow}</p>
        <h1>${screenshot.title}</h1>
        <p class="showcase-description">${screenshot.description}</p>
        <div class="showcase-tags"><span>Entra roles</span><span>PIM groups</span><span>Azure roles</span></div>
      </section>
      <section class="showcase-product"><img src="${popupDataUrl}" alt="Current QuickPIM++ popup"></section>
    </main>
  `, showcaseCss());
}

async function renderExactScreenshot(browser, fileName, capture) {
  await renderAsset(browser, fileName, 1280, 800, `
    <main class="exact-screenshot"><img src="${toDataUrl(capture, "image/png")}" alt="Current QuickPIM++ Settings"></main>
  `, assetCss());
}

function smallPromoMarkup(popupCapture) {
  return `
    <main class="promo promo-small">
      <section>
        <div class="promo-brand"><img src="${LOGO_DATA_URL}" alt=""><span>QuickPIM++</span></div>
        <h1>PIM access.<br>Ready when needed.</h1>
      </section>
      <img class="promo-popup" src="${toDataUrl(popupCapture, "image/png")}" alt="Current QuickPIM++ popup">
    </main>
  `;
}

function largePromoMarkup(popupCapture) {
  return `
    <main class="promo promo-large">
      <section>
        <div class="promo-brand"><img src="${LOGO_DATA_URL}" alt=""><span>QuickPIM++</span></div>
        <h1>Activate privileged access in a few clicks.</h1>
        <p>Entra roles, PIM groups, Azure roles, and bundles in one focused popup.</p>
      </section>
      <img class="promo-popup" src="${toDataUrl(popupCapture, "image/png")}" alt="Current QuickPIM++ popup">
    </main>
  `;
}

async function renderAsset(browser, fileName, width, height, body, styles) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html>
    <html><head><meta charset="utf-8"><style>${styles}</style></head><body>${body}</body></html>`);
  await page.screenshot({ path: resolve(OUTPUT_DIR, fileName), type: "png", animations: "disabled" });
  await page.close();
}

function assetCss() {
  return `
    *{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden}
    body{font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#eef2f6;color:#0f172a}
    .icon{width:300px;height:300px;background:transparent}.icon img{display:block;width:300px;height:300px}
    .exact-screenshot,.exact-screenshot img{display:block;width:1280px;height:800px;object-fit:cover}
  `;
}

function showcaseCss() {
  return `${assetCss()}
    .showcase{display:grid;grid-template-columns:540px 740px;width:1280px;height:800px;background:#eef3f8}
    .showcase-copy{display:flex;flex-direction:column;justify-content:center;height:100%;padding:68px 52px 68px 66px;background:#0f172a;color:#fff;border-left:12px solid #14b8a6}
    .showcase-brand{display:flex;align-items:center;gap:15px;font-size:28px;font-weight:800}
    .showcase-brand img{width:54px;height:54px}
    .eyebrow{margin:54px 0 12px;color:#5eead4;font-size:14px;font-weight:800;letter-spacing:1.4px}
    h1{margin:0;font-size:42px;line-height:1.08;letter-spacing:0;max-width:420px}
    .showcase-description{margin:22px 0 0;color:#cbd5e1;font-size:21px;line-height:1.38;max-width:420px}
    .showcase-tags{display:flex;flex-wrap:wrap;gap:8px;margin-top:32px}
    .showcase-tags span{padding:7px 11px;border:1px solid #475569;border-radius:999px;color:#e2e8f0;font-size:13px;font-weight:700}
    .showcase-product{display:flex;align-items:center;justify-content:center;padding:20px 42px 20px 34px;background:#eef3f8}
    .showcase-product img{display:block;width:624px;height:720px;border:1px solid #cbd5e1;border-radius:8px;background:#fff;box-shadow:0 22px 46px rgb(15 23 42 / 24%)}
  `;
}

function promoCss() {
  return `${assetCss()}
    .promo{position:relative;display:grid;width:100%;height:100%;overflow:hidden;background:#0f172a;color:#fff}
    .promo::before{content:"";position:absolute;inset:0 auto 0 0;width:10px;background:#14b8a6}
    .promo section{position:relative;z-index:2}
    .promo-brand{display:flex;align-items:center;gap:12px;font-weight:800}
    .promo-brand img{display:block}
    .promo h1{margin:0;letter-spacing:0}
    .promo-popup{display:block;border:1px solid #cbd5e1;border-radius:8px;background:#fff;box-shadow:0 18px 40px rgb(0 0 0 / 30%)}
    .promo-small{grid-template-columns:245px 195px;padding:28px 0 24px 30px}
    .promo-small .promo-brand{font-size:22px}.promo-small .promo-brand img{width:42px;height:42px}
    .promo-small h1{margin-top:28px;font-size:27px;line-height:1.08}
    .promo-small .promo-popup{position:absolute;right:-8px;bottom:-22px;width:190px;height:219px}
    .promo-large{grid-template-columns:760px 640px;padding:64px 0 58px 84px}
    .promo-large .promo-brand{font-size:38px;gap:18px}.promo-large .promo-brand img{width:70px;height:70px}
    .promo-large h1{max-width:650px;margin-top:52px;font-size:57px;line-height:1.06}
    .promo-large p{max-width:650px;margin:24px 0 0;color:#cbd5e1;font-size:23px;line-height:1.35}
    .promo-large .promo-popup{position:absolute;right:72px;top:38px;width:420px;height:485px}
  `;
}

function toDataUrl(buffer, mimeType) {
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

function removeObsoleteAssets() {
  for (const path of [
    resolve(OUTPUT_DIR, "screenshot-01-access-setup-1280x800.png"),
    resolve(OUTPUT_DIR, "screenshot-02-preferences-1280x800.png"),
    resolve(DOCS_DIR, "screenshot-02-access-setup-1280x800.png"),
    resolve(DOCS_DIR, "screenshot-03-enabled-features-1280x800.png")
  ]) {
    rmSync(path, { force: true });
  }
}
