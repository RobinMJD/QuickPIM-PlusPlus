import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const WEBSTORE_API_BASE = "https://chromewebstore.googleapis.com";

const REQUIRED_ENV = [
  "CHROME_WEBSTORE_CLIENT_ID",
  "CHROME_WEBSTORE_CLIENT_SECRET",
  "CHROME_WEBSTORE_REFRESH_TOKEN",
  "CHROME_WEBSTORE_PUBLISHER_ID",
  "CHROME_WEBSTORE_EXTENSION_ID",
  "CHROME_WEBSTORE_ZIP"
];

export function getMissingChromeWebStoreConfig(env = process.env) {
  return REQUIRED_ENV.filter((key) => !String(env[key] || "").trim());
}

export function readChromeWebStoreConfig(env = process.env) {
  return {
    clientId: String(env.CHROME_WEBSTORE_CLIENT_ID || "").trim(),
    clientSecret: String(env.CHROME_WEBSTORE_CLIENT_SECRET || "").trim(),
    refreshToken: String(env.CHROME_WEBSTORE_REFRESH_TOKEN || "").trim(),
    publisherId: String(env.CHROME_WEBSTORE_PUBLISHER_ID || "").trim(),
    extensionId: String(env.CHROME_WEBSTORE_EXTENSION_ID || "").trim(),
    zipPath: String(env.CHROME_WEBSTORE_ZIP || "").trim(),
    pollAttempts: readPositiveInteger(env.CHROME_WEBSTORE_UPLOAD_POLL_ATTEMPTS, 20),
    pollIntervalMs: readPositiveInteger(env.CHROME_WEBSTORE_UPLOAD_POLL_INTERVAL_MS, 15_000)
  };
}

export function buildChromeWebStoreEndpoints({ publisherId, extensionId }) {
  const encodedPublisher = encodeURIComponent(publisherId);
  const encodedExtension = encodeURIComponent(extensionId);
  return {
    tokenUrl: TOKEN_URL,
    uploadUrl: `${WEBSTORE_API_BASE}/upload/v2/publishers/${encodedPublisher}/items/${encodedExtension}:upload`,
    fetchStatusUrl: `${WEBSTORE_API_BASE}/v2/publishers/${encodedPublisher}/items/${encodedExtension}:fetchStatus`,
    publishUrl: `${WEBSTORE_API_BASE}/v2/publishers/${encodedPublisher}/items/${encodedExtension}:publish`
  };
}

export function getUploadState(payload) {
  const state = payload?.uploadState || payload?.item?.uploadState || payload?.status?.uploadState;
  return typeof state === "string" ? state : "";
}

export function isUploadInProgress(payload) {
  return /IN_PROGRESS|PENDING/i.test(getUploadState(payload));
}

export function isUploadSuccess(payload) {
  return /SUCCESS|SUCCEEDED|OK/i.test(getUploadState(payload));
}

export function isUploadFailure(payload) {
  return /FAIL|ERROR|REJECT/i.test(getUploadState(payload));
}

export function sanitizeChromeWebStoreMessage(value) {
  return String(value || "")
    .replace(/(refresh_token=)[^\s&]+/gi, "$1[redacted]")
    .replace(/(access_token=)[^\s&]+/gi, "$1[redacted]")
    .replace(/("(?:access_token|refresh_token|client_secret)"\s*:\s*")[^"]+(")/gi, "$1[redacted]$2")
    .replace(/\bya29\.[A-Za-z0-9._-]+/g, "[redacted]")
    .replace(/\b1\/\/[A-Za-z0-9._-]+/g, "[redacted]");
}

async function main() {
  const missing = getMissingChromeWebStoreConfig();
  if (missing.length) {
    console.log(
      `::notice title=Chrome Web Store publish skipped::Missing repository secrets: ${missing.join(", ")}. ` +
        "Add them to enable automatic Chrome Web Store submission on release tags."
    );
    return;
  }

  const config = readChromeWebStoreConfig();
  if (!existsSync(config.zipPath)) {
    throw new Error(`Chrome Web Store ZIP not found: ${config.zipPath}`);
  }

  const endpoints = buildChromeWebStoreEndpoints(config);
  const accessToken = await refreshAccessToken(endpoints.tokenUrl, config);
  const uploadPayload = await uploadPackage(endpoints.uploadUrl, config.zipPath, accessToken);
  const finalUploadPayload = isUploadInProgress(uploadPayload)
    ? await pollUploadStatus(endpoints.fetchStatusUrl, accessToken, config.pollAttempts, config.pollIntervalMs)
    : uploadPayload;

  assertUploadReady(finalUploadPayload);
  const publishPayload = await publishItem(endpoints.publishUrl, accessToken);
  console.log(`Chrome Web Store publish submitted for ${basename(config.zipPath)}.`);
  console.log(sanitizeChromeWebStoreMessage(JSON.stringify(publishPayload)));
}

async function refreshAccessToken(tokenUrl, config) {
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: config.refreshToken,
    grant_type: "refresh_token"
  });
  const payload = await fetchJson(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  if (!payload.access_token || typeof payload.access_token !== "string") {
    throw new Error(`Chrome Web Store token response did not include an access token: ${sanitizeChromeWebStoreMessage(JSON.stringify(payload))}`);
  }
  return payload.access_token;
}

async function uploadPackage(uploadUrl, zipPath, accessToken) {
  console.log(`Uploading ${basename(zipPath)} to Chrome Web Store...`);
  return fetchJson(uploadUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/zip"
    },
    body: readFileSync(zipPath)
  });
}

async function pollUploadStatus(fetchStatusUrl, accessToken, attempts, intervalMs) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await delay(intervalMs);
    const payload = await fetchJson(fetchStatusUrl, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!isUploadInProgress(payload)) {
      return payload;
    }
    console.log(`Chrome Web Store upload is still processing (${attempt}/${attempts})...`);
  }
  throw new Error("Chrome Web Store upload did not finish processing before the polling timeout.");
}

function assertUploadReady(payload) {
  if (isUploadSuccess(payload)) {
    return;
  }
  if (isUploadFailure(payload)) {
    throw new Error(`Chrome Web Store upload failed: ${sanitizeChromeWebStoreMessage(JSON.stringify(payload))}`);
  }
  const state = getUploadState(payload) || "unknown";
  throw new Error(`Chrome Web Store upload did not return a successful state (${state}): ${sanitizeChromeWebStoreMessage(JSON.stringify(payload))}`);
}

async function publishItem(publishUrl, accessToken) {
  console.log("Submitting Chrome Web Store item for review...");
  return fetchJson(publishUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` }
  });
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  const payload = text ? safeJson(text) : {};
  if (!response.ok) {
    throw new Error(`Chrome Web Store API request failed (${response.status}): ${sanitizeChromeWebStoreMessage(text)}`);
  }
  return payload;
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: sanitizeChromeWebStoreMessage(text) };
  }
}

function readPositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(sanitizeChromeWebStoreMessage(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  });
}
