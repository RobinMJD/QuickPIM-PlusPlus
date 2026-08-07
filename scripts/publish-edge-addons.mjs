import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

const EDGE_ADDONS_API_BASE = "https://api.addons.microsoftedge.microsoft.com/v1";
const REQUIRED_ENV = ["EDGE_ADDONS_CLIENT_ID", "EDGE_ADDONS_API_KEY", "EDGE_ADDONS_PRODUCT_ID", "EDGE_ADDONS_ZIP"];
const DEFAULT_CERTIFICATION_NOTES =
  "QuickPIM++ uses Microsoft portal tokens captured locally to display and activate eligible Entra, PIM group, and Azure roles. Settings and tokens remain in browser storage; no developer-controlled backend is used.";

export function getMissingEdgeAddonsConfig(env = process.env) {
  return REQUIRED_ENV.filter((key) => !String(env[key] || "").trim());
}

export function readEdgeAddonsConfig(env = process.env) {
  return {
    clientId: String(env.EDGE_ADDONS_CLIENT_ID || "").trim(),
    apiKey: String(env.EDGE_ADDONS_API_KEY || "").trim(),
    productId: String(env.EDGE_ADDONS_PRODUCT_ID || "").trim(),
    zipPath: String(env.EDGE_ADDONS_ZIP || "").trim(),
    certificationNotes: String(env.EDGE_ADDONS_CERTIFICATION_NOTES || DEFAULT_CERTIFICATION_NOTES).trim(),
    pollAttempts: readPositiveInteger(env.EDGE_ADDONS_POLL_ATTEMPTS, 40),
    pollIntervalMs: readPositiveInteger(env.EDGE_ADDONS_POLL_INTERVAL_MS, 15_000)
  };
}

export function buildEdgeAddonsEndpoints(productId) {
  const encodedProduct = encodeURIComponent(productId);
  const productBase = `${EDGE_ADDONS_API_BASE}/products/${encodedProduct}`;
  return {
    uploadUrl: `${productBase}/submissions/draft/package`,
    uploadStatusUrl: (operationId) =>
      `${productBase}/submissions/draft/package/operations/${encodeURIComponent(operationId)}`,
    publishUrl: `${productBase}/submissions`,
    publishStatusUrl: (operationId) => `${productBase}/submissions/operations/${encodeURIComponent(operationId)}`
  };
}

export function extractEdgeOperationId(location) {
  const value = String(location || "").trim().replace(/\/+$/, "");
  if (!value) return "";
  return decodeURIComponent(value.split("/").pop() || "");
}

export function getEdgeOperationStatus(payload) {
  return typeof payload?.status === "string" ? payload.status.toLowerCase() : "";
}

export function sanitizeEdgeAddonsMessage(value) {
  return String(value || "")
    .replace(/(Authorization:\s*(?:ApiKey|Bearer)\s+)[^\s"']+/gi, "$1[redacted]")
    .replace(/("(?:apiKey|api_key|access_token|client_secret)"\s*:\s*")[^"]+(")/gi, "$1[redacted]$2")
    .replace(/((?:api[_-]?key|access[_-]?token|client[_-]?secret)=)[^\s&]+/gi, "$1[redacted]")
    .slice(0, 4_000);
}

async function main() {
  const missing = getMissingEdgeAddonsConfig();
  if (missing.length) {
    throw new Error(`Missing required Microsoft Edge Add-ons configuration: ${missing.join(", ")}.`);
  }
  const config = readEdgeAddonsConfig();
  if (!existsSync(config.zipPath)) {
    throw new Error(`Microsoft Edge Add-ons ZIP not found: ${config.zipPath}`);
  }

  const endpoints = buildEdgeAddonsEndpoints(config.productId);
  const headers = {
    Authorization: `ApiKey ${config.apiKey}`,
    "X-ClientID": config.clientId
  };
  console.log(`Uploading ${basename(config.zipPath)} to Microsoft Edge Add-ons...`);
  const uploadOperation = await startOperation(endpoints.uploadUrl, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/zip" },
    body: readFileSync(config.zipPath)
  });
  await pollOperation(
    endpoints.uploadStatusUrl(uploadOperation),
    headers,
    config.pollAttempts,
    config.pollIntervalMs,
    "package upload"
  );

  console.log("Submitting Microsoft Edge Add-ons update for certification...");
  const publishOperation = await startOperation(endpoints.publishUrl, {
    method: "POST",
    headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" },
    body: config.certificationNotes
  });
  await pollOperation(
    endpoints.publishStatusUrl(publishOperation),
    headers,
    config.pollAttempts,
    config.pollIntervalMs,
    "submission"
  );
  console.log(`Microsoft Edge Add-ons submission accepted for ${basename(config.zipPath)}.`);
}

async function startOperation(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Microsoft Edge Add-ons API request failed (${response.status}): ${sanitizeEdgeAddonsMessage(text)}`);
  }
  const operationId = extractEdgeOperationId(response.headers.get("location"));
  if (!operationId) {
    throw new Error("Microsoft Edge Add-ons API did not return an operation ID.");
  }
  return operationId;
}

async function pollOperation(url, headers, attempts, intervalMs, label) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (attempt > 1) await delay(intervalMs);
    const response = await fetch(url, { method: "GET", headers });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Microsoft Edge Add-ons ${label} status failed (${response.status}): ${sanitizeEdgeAddonsMessage(text)}`);
    }
    const payload = safeJson(text);
    const status = getEdgeOperationStatus(payload);
    if (status === "succeeded") return payload;
    if (status === "failed") {
      throw new Error(`Microsoft Edge Add-ons ${label} failed: ${sanitizeEdgeAddonsMessage(JSON.stringify(payload))}`);
    }
    if (status !== "inprogress") {
      throw new Error(`Microsoft Edge Add-ons ${label} returned an unknown status: ${sanitizeEdgeAddonsMessage(text)}`);
    }
    console.log(`Microsoft Edge Add-ons ${label} is processing (${attempt}/${attempts})...`);
  }
  throw new Error(`Microsoft Edge Add-ons ${label} did not finish before the polling timeout.`);
}

function safeJson(text) {
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: sanitizeEdgeAddonsMessage(text) };
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
    console.error(sanitizeEdgeAddonsMessage(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  });
}
