import { describe, expect, test, vi } from "vitest";
import {
  TOKEN_STORAGE_KEYS,
  getStoredTokensFromSession,
  migrateLegacyLocalTokensToSession,
  type ChromeStorageAreaLike
} from "../src/lib/tokenStorage";

const now = Date.parse("2026-05-18T12:00:00.000Z");

describe("session token storage", () => {
  test("migrates valid legacy local tokens to session storage and removes all local token keys", async () => {
    const graphToken = makeToken({
      aud: "https://graph.microsoft.com",
      exp: Math.floor((now + 60 * 60_000) / 1000),
      oid: "user-1",
      scp: "RoleEligibilitySchedule.Read.Directory"
    });
    const azureToken = makeToken({
      aud: "https://management.core.windows.net/",
      exp: Math.floor((now + 60 * 60_000) / 1000)
    });
    const localData = {
      graphToken,
      tokenTimestamp: now,
      tokenSource: "legacy graph",
      azureManagementToken: azureToken,
      azureManagementTokenTimestamp: now,
      azureManagementTokenSource: "legacy azure"
    };
    const sessionData: Record<string, unknown> = {};
    const local = makeStorageArea(localData);
    const session = makeStorageArea(sessionData);

    const migrated = await migrateLegacyLocalTokensToSession({ local, session, now });

    expect(migrated).toBe(true);
    expect(sessionData).toMatchObject(localData);
    expect(local.remove).toHaveBeenCalledWith(TOKEN_STORAGE_KEYS);
    for (const key of TOKEN_STORAGE_KEYS) {
      expect(localData).not.toHaveProperty(key);
    }
  });

  test("drops invalid or expired legacy local tokens without copying them", async () => {
    const localData = {
      graphToken: makeToken({
        aud: "https://graph.microsoft.com",
        exp: Math.floor((now - 60_000) / 1000),
        oid: "user-1"
      }),
      tokenTimestamp: now,
      azureManagementToken: "not-a-token",
      azureManagementTokenTimestamp: now
    };
    const sessionData: Record<string, unknown> = {};
    const local = makeStorageArea(localData);
    const session = makeStorageArea(sessionData);

    const migrated = await migrateLegacyLocalTokensToSession({ local, session, now });

    expect(migrated).toBe(false);
    expect(sessionData).toEqual({});
    expect(local.remove).toHaveBeenCalledWith(TOKEN_STORAGE_KEYS);
  });

  test("reads stored tokens from session storage only after migration", async () => {
    const localData = {
      graphToken: makeToken({
        aud: "https://graph.microsoft.com",
        exp: Math.floor((now + 60 * 60_000) / 1000),
        oid: "user-1"
      }),
      tokenTimestamp: now
    };
    const sessionData = {
      azureManagementToken: makeToken({
        aud: "https://management.core.windows.net/",
        exp: Math.floor((now + 60 * 60_000) / 1000)
      }),
      azureManagementTokenTimestamp: now
    };

    const tokens = await getStoredTokensFromSession({
      local: makeStorageArea(localData),
      session: makeStorageArea(sessionData),
      now
    });

    expect(tokens).toHaveProperty("azureManagementToken");
    expect(tokens).not.toHaveProperty("graphToken");
  });
});

function makeStorageArea(data: Record<string, unknown>): ChromeStorageAreaLike {
  return {
    get: vi.fn(async (keys?: string | string[]) => {
      const selected = Array.isArray(keys) ? keys : keys ? [keys] : Object.keys(data);
      return Object.fromEntries(selected.map((key) => [key, data[key]]));
    }),
    set: vi.fn(async (value: Record<string, unknown>) => {
      Object.assign(data, value);
    }),
    remove: vi.fn(async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        delete data[key];
      }
    })
  };
}

function makeToken(payload: Record<string, unknown>): string {
  const encodedPayload = btoa(JSON.stringify(payload)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  return `header.${encodedPayload}.signature`;
}
