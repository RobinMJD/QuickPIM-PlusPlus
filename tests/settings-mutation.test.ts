import { afterEach, describe, expect, test, vi } from "vitest";
import {
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
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
});
