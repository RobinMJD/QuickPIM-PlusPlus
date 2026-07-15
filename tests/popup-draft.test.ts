import { describe, expect, test, vi } from "vitest";
import {
  POPUP_DRAFT_KEY,
  clearPopupDraft,
  hasPopupDraftContent,
  sanitizePopupDraft,
  savePopupDraft
} from "../src/lib/popupDraft";
import { MAX_USER_JUSTIFICATION_LENGTH } from "../src/lib/justifications";

const now = Date.parse("2026-06-12T12:00:00.000Z");

describe("popup draft storage", () => {
  test("sanitizes persisted popup request state", () => {
    const draft = sanitizePopupDraft(
      {
        updatedAt: now,
        tab: "pimGroup",
        search: " groups ",
        sortMode: "activationCount",
        quickFilters: ["favorites", "active", "requiresApproval", "highPrivilege", "favorites", "bad"],
        selectedIds: ["pimGroup:group-1:member", "pimGroup:group-1:member", 42],
        durationHours: 3.7,
        justification: " Need access ",
        ticketSystem: " ServiceNow ",
        ticketNumber: " INC-123 ",
        isActivationReviewOpen: true,
        requestMode: "deactivate"
      },
      now
    );

    expect(draft).toMatchObject({
      tab: "pimGroup",
      search: "groups",
      sortMode: "activationCount",
      quickFilters: ["favorites", "active"],
      selectedIds: ["pimGroup:group-1:member"],
      durationHours: 3.5,
      justification: "Need access",
      ticketSystem: "ServiceNow",
      ticketNumber: "INC-123",
      isActivationReviewOpen: true,
      requestMode: "deactivate"
    });
  });

  test("drops expired or empty drafts", () => {
    expect(sanitizePopupDraft({ updatedAt: now - 25 * 60 * 60 * 1000, selectedIds: ["role-1"] }, now)).toBeUndefined();
    expect(sanitizePopupDraft({ updatedAt: now, selectedIds: [], isActivationReviewOpen: true }, now)).toBeUndefined();
    expect(sanitizePopupDraft({ updatedAt: now + 6 * 60 * 1000, selectedIds: ["role-1"] }, now)).toBeUndefined();
    expect(sanitizePopupDraft({ updatedAt: now, selectedIds: [], tab: "pimGroup", search: "ops" }, now)).toMatchObject({
      tab: "pimGroup",
      search: "ops",
      selectedIds: []
    });
    expect(
      hasPopupDraftContent({
        tab: "directoryRole",
        search: "",
        sortMode: "name",
        selectedIds: ["role-1"],
        durationHours: 0.5,
        justification: "",
        ticketSystem: "",
        ticketNumber: "",
        isActivationReviewOpen: false,
        requestMode: "activate"
      })
    ).toBe(true);
  });

  test("drops invalid popup request modes", () => {
    expect(
      sanitizePopupDraft(
        {
          updatedAt: now,
          selectedIds: ["role-1"],
          requestMode: "delete"
        },
        now
      )?.requestMode
    ).toBeUndefined();
  });

  test("caps restored user text so the outbound audit marker still fits", () => {
    const draft = sanitizePopupDraft({
      updatedAt: now,
      selectedIds: ["directoryRole:reader:/"],
      justification: "x".repeat(2_000)
    }, now);

    expect(draft?.justification).toHaveLength(MAX_USER_JUSTIFICATION_LENGTH);
  });

  test("serializes save and clear mutations so an older save cannot resurrect a cleared draft", async () => {
    const values: Record<string, unknown> = {};
    const operations: string[] = [];
    let releaseFirstWrite: (() => void) | undefined;
    const firstWriteGate = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          set: vi.fn(async (items: Record<string, unknown>) => {
            operations.push("save:start");
            await firstWriteGate;
            Object.assign(values, items);
            operations.push("save:end");
          }),
          remove: vi.fn(async (key: string) => {
            operations.push("clear");
            delete values[key];
          })
        }
      }
    });

    const save = savePopupDraft({
      tab: "directoryRole",
      search: "",
      sortMode: "name",
      selectedIds: ["directoryRole:reader:/"],
      durationHours: 1,
      justification: "Investigate production issue",
      ticketSystem: "",
      ticketNumber: "",
      isActivationReviewOpen: true,
      requestMode: "activate"
    }, now);
    await vi.waitFor(() => expect(operations).toEqual(["save:start"]));
    const clear = clearPopupDraft();
    expect(operations).toEqual(["save:start"]);

    releaseFirstWrite?.();
    await Promise.all([save, clear]);
    expect(operations).toEqual(["save:start", "save:end", "clear"]);
    expect(values[POPUP_DRAFT_KEY]).toBeUndefined();
  });

  test("does not look up the Chrome global after a queued mutation has started", async () => {
    let releaseFirstWrite: (() => void) | undefined;
    const firstWriteGate = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    const localStorage = {
      set: vi.fn(async () => {
        await firstWriteGate;
      }),
      remove: vi.fn(async () => undefined)
    };
    vi.stubGlobal("chrome", { storage: { local: localStorage } });

    const save = savePopupDraft({
      tab: "directoryRole",
      search: "",
      sortMode: "name",
      selectedIds: ["directoryRole:reader:/"],
      durationHours: 1,
      justification: "Investigate production issue",
      ticketSystem: "",
      ticketNumber: "",
      isActivationReviewOpen: true,
      requestMode: "activate"
    }, now);
    await vi.waitFor(() => expect(localStorage.set).toHaveBeenCalledOnce());
    const clear = clearPopupDraft();

    vi.unstubAllGlobals();
    releaseFirstWrite?.();
    await expect(Promise.all([save, clear])).resolves.toEqual([undefined, undefined]);
    expect(localStorage.remove).toHaveBeenCalledWith(POPUP_DRAFT_KEY);
  });
});
