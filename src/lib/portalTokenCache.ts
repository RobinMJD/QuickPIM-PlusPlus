const JWT_PATTERN = /\b[A-Za-z0-9_-]{1,2000}\.[A-Za-z0-9_-]{1,8000}\.[A-Za-z0-9_-]{1,2000}\b/g;
const MAX_STORAGE_VALUE_LENGTH = 300_000;
const MAX_TOKENS = 20;
const MAX_JSON_DEPTH = 5;

export function collectPortalTokensFromEntries(entries: Array<[string, string | null | undefined]>): string[] {
  return collectPortalTokensFromValues(entries.map(([, value]) => value));
}

export function collectPortalTokensFromValues(values: unknown[]): string[] {
  const tokens = new Set<string>();
  for (const value of values) {
    addTokensFromValue(value, tokens);
    if (tokens.size >= MAX_TOKENS) {
      break;
    }
  }
  return [...tokens].slice(0, MAX_TOKENS);
}

function addTokensFromValue(value: unknown, tokens: Set<string>, depth = 0): void {
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

function addTokensFromText(value: string, tokens: Set<string>): void {
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

function parseJson(value: string): unknown {
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
