import { describe, expect, test, vi } from "vitest";
import {
  TOKEN_STORAGE_KEYS,
  getStoredTokensFromSession,
  migrateLegacyLocalTokensToSession,
  removeStoredTokenGroupsIfMatching,
  updateStoredTokensInSession,
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
    expect(tokens).toHaveProperty("graphToken");
    expect(localData).not.toHaveProperty("graphToken");
  });

  test("checks legacy local tokens only once for concurrent default session reads", async () => {
    const local = makeStorageArea({});
    const session = makeStorageArea({});
    vi.stubGlobal("chrome", { storage: { local, session } });

    try {
      await Promise.all([
        getStoredTokensFromSession(),
        getStoredTokensFromSession(),
        getStoredTokensFromSession()
      ]);
    } finally {
      vi.unstubAllGlobals();
    }

    expect(local.get).toHaveBeenCalledTimes(1);
    expect(local.remove).toHaveBeenCalledTimes(1);
  });

  test("does not combine legacy tokens from a different tenant or principal", async () => {
    const localData = {
      azureManagementToken: makeToken({
        aud: "https://management.core.windows.net/",
        exp: Math.floor((now + 60 * 60_000) / 1000),
        tid: "tenant-b",
        oid: "user-b"
      }),
      azureManagementTokenTimestamp: now
    };
    const sessionData = {
      graphToken: makeToken({
        aud: "https://graph.microsoft.com",
        exp: Math.floor((now + 60 * 60_000) / 1000),
        tid: "tenant-a",
        oid: "user-a"
      }),
      tokenTimestamp: now
    };

    await migrateLegacyLocalTokensToSession({
      local: makeStorageArea(localData),
      session: makeStorageArea(sessionData),
      now
    });

    expect(sessionData).not.toHaveProperty("azureManagementToken");
    expect(localData).not.toHaveProperty("azureManagementToken");
  });

  test("does not remove a freshly replaced token while cleaning an expired snapshot", async () => {
    const staleToken = "stale-token";
    const freshToken = "fresh-token";
    const sessionData: Record<string, unknown> = {
      graphToken: freshToken,
      tokenTimestamp: now
    };
    const localData: Record<string, unknown> = {};
    const session = makeStorageArea(sessionData);
    const local = makeStorageArea(localData);

    await removeStoredTokenGroupsIfMatching([{
      tokenKey: "graphToken",
      expectedToken: staleToken,
      keys: ["graphToken", "tokenTimestamp", "tokenSource"]
    }], { local, session });

    expect(sessionData.graphToken).toBe(freshToken);
    expect(session.remove).not.toHaveBeenCalled();

    await removeStoredTokenGroupsIfMatching([{
      tokenKey: "graphToken",
      expectedToken: freshToken,
      keys: ["graphToken", "tokenTimestamp", "tokenSource"]
    }], { local, session });

    expect(sessionData).not.toHaveProperty("graphToken");
    expect(sessionData).not.toHaveProperty("tokenTimestamp");
  });

  test("serializes read-modify-write token updates against the latest session state", async () => {
    const sessionData: Record<string, unknown> = {};
    const session = makeStorageArea(sessionData);
    const local = makeStorageArea({});

    const first = updateStoredTokensInSession(async (current) => {
      expect(current).not.toHaveProperty("graphToken");
      await Promise.resolve();
      return { set: { graphToken: "graph-token" }, result: "first" };
    }, { local, session });
    const second = updateStoredTokensInSession((current) => ({
      set: { azureManagementToken: current.graphToken ? "azure-token" : "wrong-order" },
      result: "second"
    }), { local, session });

    await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
    expect(sessionData).toMatchObject({
      graphToken: "graph-token",
      azureManagementToken: "azure-token"
    });
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
  const encodedPayload = btoa(JSON.stringify({ tid: "tenant-1", oid: "user-1", ...payload })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  return `header.${encodedPayload}.signature`;
}
