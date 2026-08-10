export const CHROME_WEB_STORE_EXTENSION_ID = "knhfobbilpoaigbpondpadjdmikhdljn";
export const EDGE_ADDONS_EXTENSION_ID = "kkonicmefghaignpfelhjfpmpecjgfld";
export const EDGE_ADDONS_URL = `https://microsoftedge.microsoft.com/addons/detail/quickpim/${EDGE_ADDONS_EXTENSION_ID}`;
export const CHROME_WEB_STORE_URL = `https://chromewebstore.google.com/detail/${CHROME_WEB_STORE_EXTENSION_ID}`;

const CHROME_WEB_STORE_UPDATE_ORIGIN = "https://clients2.google.com/service/update2/crx";
const EDGE_ADDONS_UPDATE_ORIGIN = "https://edge.microsoft.com/extensionwebstorebase/v1/crx";

export type BrowserFamily = "edge" | "chrome" | "chromium" | "other";
export type ExtensionDistribution = "edgeAddons" | "chromeWebStore" | "development" | "managed" | "sideload" | "unknown";

export interface ExtensionDistributionInfo {
  browser: BrowserFamily;
  distribution: ExtensionDistribution;
  extensionId: string;
  installType?: chrome.management.ExtensionInfo["installType"];
  updateUrl?: string;
  blockedInEdge: boolean;
}

interface DistributionInput {
  userAgent?: string;
  brands?: Array<{ brand: string; version?: string }>;
  extensionId?: string;
  installType?: chrome.management.ExtensionInfo["installType"];
  updateUrl?: string;
}

export function detectBrowserFamily(
  userAgent = "",
  brands: Array<{ brand: string; version?: string }> = []
): BrowserFamily {
  const brandNames = brands.map((entry) => entry.brand.toLowerCase());
  if (brandNames.some((brand) => brand.includes("microsoft edge")) || /\bEdg(?:A|iOS)?\//i.test(userAgent)) {
    return "edge";
  }
  if (
    brandNames.some((brand) => /brave|opera|vivaldi|chromium/i.test(brand))
    || /\b(?:OPR|Vivaldi|YaBrowser|SamsungBrowser)\//i.test(userAgent)
  ) {
    return "chromium";
  }
  if (brandNames.some((brand) => brand === "google chrome") || /\b(?:Chrome|CriOS)\//i.test(userAgent)) {
    return "chrome";
  }
  if (brandNames.some((brand) => brand.includes("chromium")) || /\bChromium\//i.test(userAgent)) {
    return "chromium";
  }
  return "other";
}

export function classifyExtensionDistribution(input: DistributionInput): ExtensionDistributionInfo {
  const browser = detectBrowserFamily(input.userAgent, input.brands);
  const extensionId = input.extensionId || "";
  const updateUrl = input.updateUrl?.trim();
  let distribution: ExtensionDistribution = "unknown";

  if (extensionId === EDGE_ADDONS_EXTENSION_ID || updateUrl?.startsWith(EDGE_ADDONS_UPDATE_ORIGIN)) {
    distribution = "edgeAddons";
  } else if (extensionId === CHROME_WEB_STORE_EXTENSION_ID || updateUrl?.startsWith(CHROME_WEB_STORE_UPDATE_ORIGIN)) {
    distribution = "chromeWebStore";
  } else if (input.installType === "development") {
    distribution = "development";
  } else if (input.installType === "admin") {
    distribution = "managed";
  } else if (input.installType === "sideload") {
    distribution = "sideload";
  }

  return {
    browser,
    distribution,
    extensionId,
    installType: input.installType,
    updateUrl,
    blockedInEdge: browser === "edge" && distribution === "chromeWebStore"
  };
}

export async function getExtensionDistributionInfo(): Promise<ExtensionDistributionInfo> {
  const navigatorWithHints = navigator as Navigator & {
    userAgentData?: { brands?: Array<{ brand: string; version?: string }> };
  };
  let self: chrome.management.ExtensionInfo | undefined;
  try {
    self = await chrome.management?.getSelf?.();
  } catch {
    // Runtime id and browser identity still provide a safe fallback.
  }
  return classifyExtensionDistribution({
    userAgent: navigator.userAgent,
    brands: navigatorWithHints.userAgentData?.brands,
    extensionId: self?.id || chrome.runtime.id,
    installType: self?.installType,
    updateUrl: self?.updateUrl
  });
}

export function browserFamilyLabel(browser: BrowserFamily): string {
  if (browser === "edge") return "Microsoft Edge";
  if (browser === "chrome") return "Google Chrome";
  if (browser === "chromium") return "Chromium browser";
  return "Other browser";
}

export function distributionLabel(distribution: ExtensionDistribution): string {
  if (distribution === "edgeAddons") return "Microsoft Edge Add-ons";
  if (distribution === "chromeWebStore") return "Chrome Web Store";
  if (distribution === "development") return "Local development install";
  if (distribution === "managed") return "Managed installation";
  if (distribution === "sideload") return "Sideloaded installation";
  return "Unknown installation source";
}

const ACTION_ICON_PATHS = {
  16: "img/QuickPim16.png",
  48: "img/QuickPim48.png",
  128: "img/QuickPim128.png"
};

export async function applyDistributionActionIcon(info: ExtensionDistributionInfo): Promise<void> {
  if (!chrome.action?.setIcon) return;
  if (!info.blockedInEdge) {
    await chrome.action.setIcon({ path: ACTION_ICON_PATHS });
    return;
  }

  try {
    const imageData = Object.fromEntries(await Promise.all(
      Object.entries(ACTION_ICON_PATHS).map(async ([size, path]) => [size, await loadGrayscaleIcon(path)] as const)
    ));
    await chrome.action.setIcon({ imageData });
  } catch {
    // A badge remains visible even on platforms that cannot create ImageData in a service worker.
    await chrome.action.setIcon({ path: ACTION_ICON_PATHS });
    await chrome.action.setBadgeBackgroundColor?.({ color: "#64748b" });
    await chrome.action.setBadgeText?.({ text: "!" });
  }
}

async function loadGrayscaleIcon(path: string): Promise<ImageData> {
  const response = await fetch(chrome.runtime.getURL(path));
  if (!response.ok) throw new Error("Extension icon could not be loaded.");
  const bitmap = await createImageBitmap(await response.blob());
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Extension icon canvas is unavailable.");
  context.drawImage(bitmap, 0, 0);
  const image = context.getImageData(0, 0, bitmap.width, bitmap.height);
  for (let index = 0; index < image.data.length; index += 4) {
    const gray = Math.round(
      image.data[index] * 0.2126
      + image.data[index + 1] * 0.7152
      + image.data[index + 2] * 0.0722
    );
    image.data[index] = gray;
    image.data[index + 1] = gray;
    image.data[index + 2] = gray;
    image.data[index + 3] = Math.round(image.data[index + 3] * 0.72);
  }
  return image;
}
