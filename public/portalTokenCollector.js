(() => {
  const JWT_PATTERN = /\b[A-Za-z0-9_-]{1,2000}\.[A-Za-z0-9_-]{1,8000}\.[A-Za-z0-9_-]{1,2000}\b/g;
  const MAX_STORAGE_VALUE_LENGTH = 8 * 1024 * 1024;
  const STORAGE_SCAN_CHUNK_LENGTH = 256 * 1024;
  // MSAL can retain several scoped tokens per account. Keep enough candidates for
  // the background selector to choose coherent Entra, PIM Group, and Azure tokens.
  const MAX_TOKENS = 100;
  const MAX_TOKEN_CANDIDATES = 500;
  const MAX_JSON_DEPTH = 5;
  const MAX_ATTEMPTS = 45;
  const MAX_INDEXED_DB_DATABASES = 32;
  const MAX_INDEXED_DB_STORES = 100;
  const MAX_INDEXED_DB_RECORDS_PER_STORE = 250;
  const INDEXED_DB_TOTAL_BUDGET_MS = 6000;
  const INDEXED_DB_OPEN_TIMEOUT_MS = 1000;
  const INDEXED_DB_STORE_TIMEOUT_MS = 1500;
  const CAPTURE_RESPONSE_TIMEOUT_MS = 5000;
  const IDLE_RESCAN_INTERVAL_MS = 30000;
  let attempts = 0;
  let activeScan;
  let interval;
  let lastTokenFingerprint = "";
  let lastAutomaticScanAt = 0;
  let forcedFollowUp;

  function scan(options = {}) {
    if (activeScan) {
      if (!options.force) return activeScan;
      forcedFollowUp ||= activeScan.catch(() => undefined).then(() => {
        forcedFollowUp = undefined;
        return scan({ force: true, includeIndexedDb: true });
      });
      return forcedFollowUp;
    }

    const scanRun = performScan(options);
    const trackedRun = scanRun.finally(() => {
      if (activeScan === trackedRun) {
        activeScan = undefined;
      }
    });
    activeScan = trackedRun;
    return trackedRun;
  }

  async function performScan({ force = false, includeIndexedDb = false } = {}) {
    const now = Date.now();
    if (!force && attempts >= MAX_ATTEMPTS && now - lastAutomaticScanAt < IDLE_RESCAN_INTERVAL_MS) {
      return { tokenCount: 0, captured: [] };
    }
    if (!force) lastAutomaticScanAt = now;
    attempts += 1;
    const shouldIncludeIndexedDb = includeIndexedDb || attempts <= 3 || attempts % 5 === 0;
    const tokens = await collectPortalTokens(shouldIncludeIndexedDb);
    const fingerprint = fingerprintTokens(tokens);
    if (!tokens.length || (!force && fingerprint === lastTokenFingerprint)) {
      return { tokenCount: tokens.length, captured: [] };
    }

    const result = await submitTokens(tokens, fingerprint);
    if (result.delivered) {
      lastTokenFingerprint = fingerprint;
    }
    return { tokenCount: tokens.length, captured: result.captured };
  }

  function submitTokens(tokens, fingerprint) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          resolve(result);
        }
      };
      const timeout = setTimeout(() => finish({ delivered: false, captured: [] }), CAPTURE_RESPONSE_TIMEOUT_MS);
      try {
        chrome.runtime.sendMessage(
          {
            action: "capturePortalTokens",
            tokens,
            source: "Microsoft Entra portal storage"
          },
          (response) => {
            const runtimeError = chrome.runtime.lastError;
            const captured = response && response.success && Array.isArray(response.data?.captured)
              ? response.data.captured
              : [];
            const delivered = !runtimeError && Boolean(response?.success);
            // The callback may arrive after our response timeout. Remember a
            // successful late delivery so the periodic scanner does not keep
            // resubmitting the same token set.
            if (delivered) lastTokenFingerprint = fingerprint;
            finish({ delivered, captured });
          }
        );
      } catch {
        finish({ delivered: false, captured: [] });
      }
    });
  }

  async function collectPortalTokens(includeIndexedDb) {
    const tokens = new Set();
    collectStorageTokens(window.localStorage, tokens);
    collectStorageTokens(window.sessionStorage, tokens);
    if (includeIndexedDb) {
      await collectIndexedDbTokens(tokens);
    }
    return [...tokens]
      .sort(compareTokenCandidates)
      .slice(0, MAX_TOKENS);
  }

  function collectStorageTokens(storage, tokens) {
    try {
      const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index))
        .filter(Boolean)
        .sort((left, right) => storageKeyPriority(right) - storageKeyPriority(left) || left.localeCompare(right));
      for (const key of keys) {
        if (!key) continue;
        addTokensFromValue(storage.getItem(key), tokens);
      }
    } catch {
      // Some portal frames may deny storage access. The next scan can still succeed from another frame.
    }
  }

  async function collectIndexedDbTokens(tokens) {
    if (
      tokens.size >= MAX_TOKEN_CANDIDATES ||
      !window.indexedDB ||
      typeof window.indexedDB.databases !== "function"
    ) {
      return;
    }

    let databases;
    try {
      databases = await window.indexedDB.databases();
    } catch {
      return;
    }

    const deadline = Date.now() + INDEXED_DB_TOTAL_BUDGET_MS;
    const prioritizedDatabases = [...databases].sort((left, right) =>
      storageKeyPriority(right?.name || "") - storageKeyPriority(left?.name || "")
      || String(left?.name || "").localeCompare(String(right?.name || ""))
    );
    for (const databaseInfo of prioritizedDatabases.slice(0, MAX_INDEXED_DB_DATABASES)) {
      const databaseName = databaseInfo && databaseInfo.name;
      if (!databaseName || tokens.size >= MAX_TOKEN_CANDIDATES || Date.now() >= deadline) {
        continue;
      }

      const database = await openDatabase(databaseName);
      if (!database) {
        continue;
      }

      try {
        const storeNames = Array.from(database.objectStoreNames)
          .sort((left, right) => storageKeyPriority(right) - storageKeyPriority(left) || left.localeCompare(right))
          .slice(0, MAX_INDEXED_DB_STORES);
        for (const storeName of storeNames) {
          if (tokens.size >= MAX_TOKEN_CANDIDATES || Date.now() >= deadline) {
            break;
          }
          await collectObjectStoreTokens(database, storeName, tokens);
        }
      } finally {
        database.close();
      }
    }
  }

  function openDatabase(databaseName) {
    return new Promise((resolve) => {
      let settled = false;
      let timeout;
      function finish(value) {
        if (settled) {
          if (value && typeof value.close === "function") value.close();
          return;
        }
        settled = true;
        clearTimeout(timeout);
        resolve(value);
      }
      timeout = setTimeout(() => finish(undefined), INDEXED_DB_OPEN_TIMEOUT_MS);
      try {
        const request = window.indexedDB.open(databaseName);
        request.onerror = () => finish(undefined);
        request.onblocked = () => finish(undefined);
        request.onsuccess = () => finish(request.result);
      } catch {
        finish(undefined);
      }
    });
  }

  function collectObjectStoreTokens(database, storeName, tokens) {
    return new Promise((resolve) => {
      let finished = false;
      let recordsRead = 0;
      let transaction;
      let timeout;

      function finish() {
        if (!finished) {
          finished = true;
          clearTimeout(timeout);
          resolve();
        }
      }

      try {
        transaction = database.transaction(storeName, "readonly");
        timeout = setTimeout(() => {
          try {
            transaction.abort();
          } catch {
            // A completed transaction needs no cancellation.
          }
          finish();
        }, INDEXED_DB_STORE_TIMEOUT_MS);
        const store = transaction.objectStore(storeName);
        const request = store.openCursor();

        request.onerror = finish;
        transaction.onerror = finish;
        transaction.onabort = finish;
        transaction.oncomplete = finish;
        request.onsuccess = () => {
          if (finished) {
            return;
          }

          if (tokens.size >= MAX_TOKEN_CANDIDATES || recordsRead >= MAX_INDEXED_DB_RECORDS_PER_STORE) {
            try {
              transaction.abort();
            } catch {
              // The transaction may have already completed.
            }
            finish();
            return;
          }

          const cursor = request.result;
          if (!cursor) {
            finish();
            return;
          }

          recordsRead += 1;
          addTokensFromValue(cursor.value, tokens);
          try {
            cursor.continue();
          } catch {
            finish();
          }
        };
      } catch {
        finish();
      }
    });
  }

  function addTokensFromValue(value, tokens, depth = 0) {
    if (tokens.size >= MAX_TOKEN_CANDIDATES || value === undefined || value === null || depth > MAX_JSON_DEPTH) {
      return;
    }
    if (typeof value === "string") {
      addTokensFromText(value, tokens);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        addTokensFromValue(item, tokens, depth + 1);
      }
      return;
    }
    if (typeof value === "object") {
      for (const item of Object.values(value)) {
        addTokensFromValue(item, tokens, depth + 1);
      }
    }
  }

  function addTokensFromText(value, tokens) {
    if (!value || tokens.size >= MAX_TOKEN_CANDIDATES) {
      return;
    }
    const boundedValue = value.slice(0, MAX_STORAGE_VALUE_LENGTH);
    for (let offset = 0; offset < boundedValue.length; offset += STORAGE_SCAN_CHUNK_LENGTH) {
      const chunk = boundedValue.slice(Math.max(0, offset - 12000), offset + STORAGE_SCAN_CHUNK_LENGTH);
      for (const match of chunk.matchAll(JWT_PATTERN)) {
        if (isSupportedApiToken(match[0])) tokens.add(match[0]);
        if (tokens.size >= MAX_TOKEN_CANDIDATES) return;
      }
    }
    const parsed = value.length <= 300000 ? parseJson(value) : undefined;
    if (parsed !== undefined) {
      addTokensFromValue(parsed, tokens, 1);
    }
  }

  function isSupportedApiToken(token) {
    try {
      const payload = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      const decoded = JSON.parse(atob(payload.padEnd(Math.ceil(payload.length / 4) * 4, "=")));
      const audiences = Array.isArray(decoded.aud) ? decoded.aud : [decoded.aud];
      const allowedAudiences = new Set([
        "https://graph.microsoft.com",
        "https://graph.microsoft.com/",
        "00000003-0000-0000-c000-000000000000",
        "https://management.azure.com",
        "https://management.azure.com/",
        "https://management.core.windows.net/",
        "797f4846-ba00-4fd7-ba43-dac1f8f63013"
      ]);
      return Number(decoded.exp) * 1000 > Date.now() && audiences.some((audience) => allowedAudiences.has(audience));
    } catch {
      return false;
    }
  }

  function parseJson(value) {
    const trimmed = value.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
      return undefined;
    }
    try {
      return JSON.parse(trimmed);
    } catch {
      return undefined;
    }
  }

  function compareTokenCandidates(left, right) {
    const leftMetadata = tokenMetadata(left);
    const rightMetadata = tokenMetadata(right);
    return rightMetadata.score - leftMetadata.score
      || rightMetadata.expiry - leftMetadata.expiry
      || left.localeCompare(right);
  }

  function tokenMetadata(token) {
    try {
      const payload = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      const decoded = JSON.parse(atob(payload.padEnd(Math.ceil(payload.length / 4) * 4, "=")));
      const scopes = String(decoded.scp || "").toLowerCase();
      const audience = String(decoded.aud || "").toLowerCase();
      return {
        expiry: Number(decoded.exp) || 0,
        score: Number(scopes.includes("readwrite")) * 8
          + Number(scopes.includes("roleassignmentschedule")) * 4
          + Number(scopes.includes("privilegedassignmentschedule")) * 4
          + Number(audience.includes("management")) * 2
      };
    } catch {
      return { expiry: 0, score: 0 };
    }
  }

  function storageKeyPriority(value) {
    const key = String(value || "").toLowerCase();
    return Number(key.includes("msal")) * 8
      + Number(key.includes("token")) * 4
      + Number(key.includes("auth")) * 2
      + Number(key.includes("cache"));
  }

  function fingerprintTokens(tokens) {
    let first = 0x811c9dc5;
    let second = 0x9e3779b9;
    for (const token of [...tokens].sort()) {
      for (let index = 0; index < token.length; index += 1) {
        const code = token.charCodeAt(index);
        first = Math.imul(first ^ code, 0x01000193);
        second = Math.imul(second ^ code, 0x85ebca6b);
      }
    }
    return `${tokens.length}:${(first >>> 0).toString(16)}:${(second >>> 0).toString(16)}`;
  }

  void scan();
  interval = setInterval(() => void scan(), 2000);
  window.addEventListener("hashchange", () => void scan());
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void scan();
  });
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message && message.action === "quickPimScanPortalTokens") {
      void scan({ force: true, includeIndexedDb: true }).then(
        (result) => sendResponse({ success: true, data: result }),
        () => sendResponse({ success: false, error: "Portal token scan failed." })
      );
      return true;
    }
    return false;
  });
})();
