(() => {
  const JWT_PATTERN = /\b[A-Za-z0-9_-]{1,2000}\.[A-Za-z0-9_-]{1,8000}\.[A-Za-z0-9_-]{1,2000}\b/g;
  const MAX_STORAGE_VALUE_LENGTH = 300000;
  const MAX_TOKENS = 20;
  const MAX_JSON_DEPTH = 5;
  const MAX_ATTEMPTS = 45;
  const MAX_INDEXED_DB_DATABASES = 12;
  const MAX_INDEXED_DB_STORES = 40;
  const MAX_INDEXED_DB_RECORDS_PER_STORE = 100;
  const CAPTURE_RESPONSE_TIMEOUT_MS = 5000;
  let attempts = 0;
  let activeScan;
  let interval;
  let lastTokenFingerprint = "";

  function scan(options = {}) {
    if (activeScan) {
      return options.force ? activeScan.then(() => scan(options)) : activeScan;
    }

    const scanRun = performScan(options);
    const trackedRun = scanRun.finally(() => {
      if (activeScan === trackedRun) {
        activeScan = undefined;
      }
      if (attempts >= MAX_ATTEMPTS && interval !== undefined) {
        clearInterval(interval);
      }
    });
    activeScan = trackedRun;
    return trackedRun;
  }

  async function performScan({ force = false, includeIndexedDb = false } = {}) {
    attempts += 1;
    const shouldIncludeIndexedDb = window === window.top && (includeIndexedDb || attempts <= 3 || attempts % 5 === 0);
    const tokens = await collectPortalTokens(shouldIncludeIndexedDb);
    const fingerprint = tokens.slice().sort().join("|");
    if (!tokens.length || (!force && fingerprint === lastTokenFingerprint)) {
      return { tokenCount: tokens.length, captured: [] };
    }

    const result = await submitTokens(tokens);
    if (result.delivered) {
      lastTokenFingerprint = fingerprint;
      if (result.captured.length && interval !== undefined) {
        clearInterval(interval);
      }
    }
    return { tokenCount: tokens.length, captured: result.captured };
  }

  function submitTokens(tokens) {
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
            source: `entra.microsoft.com storage: ${location.hash.slice(0, 120)}`
          },
          (response) => {
            const runtimeError = chrome.runtime.lastError;
            const captured = response && response.success && Array.isArray(response.data?.captured)
              ? response.data.captured
              : [];
            finish({ delivered: !runtimeError && Boolean(response?.success), captured });
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
    return [...tokens].slice(0, MAX_TOKENS);
  }

  function collectStorageTokens(storage, tokens) {
    try {
      for (let index = 0; index < storage.length && tokens.size < MAX_TOKENS; index += 1) {
        const key = storage.key(index);
        if (!key) continue;
        addTokensFromValue(storage.getItem(key), tokens);
      }
    } catch {
      // Some portal frames may deny storage access. The next scan can still succeed from another frame.
    }
  }

  async function collectIndexedDbTokens(tokens) {
    if (
      tokens.size >= MAX_TOKENS ||
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

    for (const databaseInfo of databases.slice(0, MAX_INDEXED_DB_DATABASES)) {
      const databaseName = databaseInfo && databaseInfo.name;
      if (!databaseName || tokens.size >= MAX_TOKENS) {
        continue;
      }

      const database = await openDatabase(databaseName);
      if (!database) {
        continue;
      }

      try {
        const storeNames = Array.from(database.objectStoreNames).slice(0, MAX_INDEXED_DB_STORES);
        for (const storeName of storeNames) {
          if (tokens.size >= MAX_TOKENS) {
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
      function finish(value) {
        if (settled) {
          if (value && typeof value.close === "function") value.close();
          return;
        }
        settled = true;
        resolve(value);
      }
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

      function finish() {
        if (!finished) {
          finished = true;
          resolve();
        }
      }

      try {
        const transaction = database.transaction(storeName, "readonly");
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

          if (tokens.size >= MAX_TOKENS || recordsRead >= MAX_INDEXED_DB_RECORDS_PER_STORE) {
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
    if (tokens.size >= MAX_TOKENS || value === undefined || value === null || depth > MAX_JSON_DEPTH) {
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
    if (!value || value.length > MAX_STORAGE_VALUE_LENGTH || tokens.size >= MAX_TOKENS) {
      return;
    }
    for (const match of value.matchAll(JWT_PATTERN)) {
      if (isSupportedApiToken(match[0])) tokens.add(match[0]);
      if (tokens.size >= MAX_TOKENS) {
        return;
      }
    }
    const parsed = parseJson(value);
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
