import { afterEach, describe, expect, test, vi } from "vitest";
import {
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
  SETTINGS_REVISION_KEY,
  compareAndSetSettingsInStorage,
  mutateSettings
} from "../src/lib/settings";

describe("settings mutations", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("serializes concurrent section updates without losing either change", async () => {
    const data: Record<string, unknown> = { [SETTINGS_KEY]: DEFAULT_SETTINGS };
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: data[key] })),
          set: vi.fn(async (value: Record<string, unknown>) => {
            await Promise.resolve();
            Object.assign(data, value);
          })
        }
      }
    });

    await Promise.all([
      mutateSettings((current) => ({
        ...current,
        aliasesByItemId: { ...current.aliasesByItemId, "directoryRole:role-1:/": "Reader" }
      })),
      mutateSettings((current) => ({
        ...current,
        preferences: { ...current.preferences, darkMode: true }
      }))
    ]);

    expect(data[SETTINGS_KEY]).toMatchObject({
      aliasesByItemId: { "directoryRole:role-1:/": "Reader" },
      preferences: { darkMode: true }
    });
  });

  test("rejects a stale cross-context write and preserves both edits after retry", async () => {
    const data: Record<string, unknown> = {
      [SETTINGS_KEY]: structuredClone(DEFAULT_SETTINGS),
      [SETTINGS_REVISION_KEY]: 0
    };
    const storage = {
      get: vi.fn(async (key: string) => ({ [key]: data[key] })),
      set: vi.fn(async (value: Record<string, unknown>) => {
        Object.assign(data, value);
      })
    };
    const firstCandidate = {
      ...DEFAULT_SETTINGS,
      aliasesByItemId: { "directoryRole:role-1:/": "Reader" }
    };
    const staleSecondCandidate = {
      ...DEFAULT_SETTINGS,
      preferences: { ...DEFAULT_SETTINGS.preferences, darkMode: true }
    };

    const first = await compareAndSetSettingsInStorage(storage, 0, firstCandidate);
    const stale = await compareAndSetSettingsInStorage(storage, 0, staleSecondCandidate);
    const retried = await compareAndSetSettingsInStorage(storage, stale.revision, {
      ...stale.settings,
      preferences: { ...stale.settings.preferences, darkMode: true }
    });

    expect(first.applied).toBe(true);
    expect(stale.applied).toBe(false);
    expect(retried.applied).toBe(true);
    expect(data[SETTINGS_KEY]).toMatchObject({
      aliasesByItemId: { "directoryRole:role-1:/": "Reader" },
      preferences: { darkMode: true }
    });
    expect(data[SETTINGS_REVISION_KEY]).toBe(2);
  });
});
